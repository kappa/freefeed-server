import createDebug from 'debug';
import Raven from 'raven';
import config from 'config';

import { safeRequestSummary } from './safe-request-summary';

const debug = createDebug('freefeed:errors');

const sentryIsEnabled = 'sentryDsn' in config;

export function reportError(ctx) {
  return (err) => {
    const isPublic = publicTypes.some((Type) => err instanceof Type);
    const { method, path, requestId } = safeRequestSummary(ctx);
    const errName = err instanceof Error ? err.constructor.name : `non-error:${typeof err}`;
    const rawStack = err instanceof Error && typeof err.stack === 'string' ? err.stack : '';
    // V8 renders the complete (possibly multiline) message before the frames,
    // so the preamble occupies exactly as many lines as the message itself.
    // Counting from the message also drops continuations that mimic frames.
    const preambleLines =
      err instanceof Error && typeof err.message === 'string' ? err.message.split('\n').length : 1;
    const locations = rawStack.split('\n').slice(preambleLines).join('\n');

    debug(
      `${requestId} ${method} ${path} :: ${errName} (${isPublic ? 'public' : 'unexpected'})${locations ? `\n${locations}` : ''}`,
    );

    if (!isPublic && err instanceof Error && sentryIsEnabled) {
      try {
        Raven.captureException(err, { req: ctx.request });
      } catch {
        // A diagnostic transport failure must not replace the client response
      }
    }

    ctx.status = isPublic ? err.status : 500;
    ctx.body = { err: isPublic ? err.message : 'Internal Server Error' };
  };
}

export class BadRequestException extends Error {
  constructor(message = 'Bad Request') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 400;
  }
}

export class NotAuthorizedException extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 401;
  }
}

export class ForbiddenException extends Error {
  constructor(message = 'Forbidden') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 403;
  }
}

export class NotFoundException extends Error {
  constructor(message = 'Not found') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 404;
  }
}

export class ValidationException extends Error {
  constructor(message = 'Invalid') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 422;
  }
}

export class TooManyRequestsException extends Error {
  constructor(message = 'Too Many Requests') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 429;
  }
}

export class ContentTooLargeException extends Error {
  constructor(message = 'Content Too Large') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 413;
  }
}

export class ServerErrorException extends Error {
  constructor(message = 'Internal server error') {
    super(message);
    Error.captureStackTrace(this, this.constructor);
    this.status = 500;
  }
}

// Outermost error guard: body parsing and static serving run before the main
// error handler, so their failures are adapted here. Transport-level 400/413
// keep their status with fixed safe messages; everything else goes through
// the same sanitized reporting path.
export async function outerErrorMiddleware(ctx, next) {
  try {
    await next();
  } catch (e) {
    if (e && (e.status === 400 || e.status === 413)) {
      ctx.status = e.status;
      ctx.body = { err: e.status === 400 ? 'Bad Request' : 'Content Too Large' };
      return;
    }

    reportError(ctx)(e);
  }
}

// Only these exception types stay public; everything else, including
// ServerErrorException, gets the generic 500 response
const publicTypes = [
  BadRequestException,
  NotAuthorizedException,
  ForbiddenException,
  NotFoundException,
  ValidationException,
  TooManyRequestsException,
  ContentTooLargeException,
];
