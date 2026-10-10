import { format } from 'util';

import { after, before, beforeEach, describe, it } from 'mocha';
import createDebug from 'debug';
import expect from 'unexpected';

import {
  BadRequestException,
  ContentTooLargeException,
  ForbiddenException,
  NotAuthorizedException,
  NotFoundException,
  ServerErrorException,
  TooManyRequestsException,
  ValidationException,
  outerErrorMiddleware,
  reportError,
} from '../../app/support/exceptions';

const makeCtx = () => ({
  request: {
    method: 'GET',
    url: '/v1/users/me?authToken=ctxsecret08',
    body: { authToken: 'ctxbodysecret08' },
  },
  state: { id: 'req-08-1' },
  status: 0,
  body: null as unknown,
});

describe('reportError', () => {
  const capturedDebug: string[] = [];
  const originalDebugLog = createDebug.log;

  before(() => {
    createDebug.enable('freefeed:errors');
    createDebug.log = (...args: unknown[]) => {
      capturedDebug.push(format(...args));
    };
  });

  after(() => {
    createDebug.disable();
    createDebug.log = originalDebugLog;
  });

  beforeEach(() => {
    capturedDebug.length = 0;
  });

  const publicCases = [
    { err: new BadRequestException('bad08a'), status: 400, message: 'bad08a' },
    { err: new NotAuthorizedException('auth08a'), status: 401, message: 'auth08a' },
    { err: new ForbiddenException('forbid08a'), status: 403, message: 'forbid08a' },
    { err: new NotFoundException('missing08a'), status: 404, message: 'missing08a' },
    { err: new ValidationException('invalid08a'), status: 422, message: 'invalid08a' },
    { err: new TooManyRequestsException('slow08a'), status: 429, message: 'slow08a' },
    { err: new ContentTooLargeException('huge08a'), status: 413, message: 'huge08a' },
  ];

  for (const { err, status, message } of publicCases) {
    it(`should preserve status/message of ${err.constructor.name}`, () => {
      const ctx = makeCtx();
      reportError(ctx)(err);

      expect(ctx.status, 'to be', status);
      expect(ctx.body, 'to equal', { err: message });
    });
  }

  it('should mark public errors in diagnostics without request credentials', () => {
    const ctx = makeCtx();
    reportError(ctx)(new ValidationException('invalid08b'));

    const diagnostics = capturedDebug.join('\n');
    expect(diagnostics, 'to contain', 'public');
    expect(diagnostics, 'to contain', 'req-08-1');
    expect(diagnostics, 'to contain', '/v1/users/me');
    expect(diagnostics, 'not to contain', 'ctxsecret08');
    expect(diagnostics, 'not to contain', 'ctxbodysecret08');
  });

  it('should return a generic 500 for a plain Error and keep its message out of diagnostics', () => {
    const ctx = makeCtx();
    reportError(ctx)(new Error(`SELECT * FROM users WHERE password='s3cret08a'`));

    expect(ctx.status, 'to be', 500);
    expect(ctx.body, 'to equal', { err: 'Internal Server Error' });

    const diagnostics = capturedDebug.join('\n');
    expect(diagnostics, 'not to contain', 's3cret08a');
    expect(diagnostics, 'to contain', 'unexpected');
    expect(diagnostics, 'to contain', 'req-08-1');
    expect(diagnostics, 'to contain', 'at ');
  });

  it('should mask database-shaped errors the same way in test and production', () => {
    const withInternalQuery = Object.assign(new Error('query failed s3cret08b'), {
      internalQuery: 'SELECT s3cret08b FROM users',
    });
    const withRawQuery = new Error('failure when compiling RAW query s3cret08c');

    for (const err of [withInternalQuery, withRawQuery]) {
      const ctx = makeCtx();
      reportError(ctx)(err);

      expect(ctx.status, 'to be', 500);
      expect(ctx.body, 'to equal', { err: 'Internal Server Error' });
    }

    expect(capturedDebug.join('\n'), 'not to contain', 's3cret08');
  });

  it('should strip every message line including frame-like continuations', () => {
    const ctx = makeCtx();
    const message = [
      'query failed: SELECT * FROM users',
      `password='multiline08b'`,
      '    at TOKEN_SENTINEL08c',
    ].join('\n');
    reportError(ctx)(new Error(message));

    expect(ctx.status, 'to be', 500);
    expect(ctx.body, 'to equal', { err: 'Internal Server Error' });

    const diagnostics = capturedDebug.join('\n');
    expect(diagnostics, 'not to contain', 'SELECT * FROM users');
    expect(diagnostics, 'not to contain', 'multiline08b');
    expect(diagnostics, 'not to contain', 'TOKEN_SENTINEL08c');
    expect(diagnostics, 'to contain', 'Context.<anonymous>');
    expect(diagnostics, 'to contain', 'req-08-1');
  });

  it('should return a generic 500 for ServerErrorException', () => {
    const ctx = makeCtx();
    reportError(ctx)(new ServerErrorException('Server exploded: s3cret08d'));

    expect(ctx.status, 'to be', 500);
    expect(ctx.body, 'to equal', { err: 'Internal Server Error' });
    expect(capturedDebug.join('\n'), 'not to contain', 's3cret08d');
  });

  it('should not throw a second exception for null, strings or plain objects', () => {
    const cases: unknown[] = [
      null,
      'boom-string-08e',
      { status: 418, message: 'teapot08f' },
      { message: 'Corrupt image' },
      { status: 500, message: 'Internal server error' },
    ];

    for (const err of cases) {
      const ctx = makeCtx();
      expect(() => reportError(ctx)(err), 'not to throw');
      expect(ctx.status, 'to be', 500);
      expect(ctx.body, 'to equal', { err: 'Internal Server Error' });
    }

    const diagnostics = capturedDebug.join('\n');
    expect(diagnostics, 'not to contain', 'boom-string-08e');
    expect(diagnostics, 'not to contain', 'teapot08f');
  });
});

describe('outerErrorMiddleware', () => {
  const capturedDebug: string[] = [];
  const originalDebugLog = createDebug.log;

  before(() => {
    createDebug.enable('freefeed:errors');
    createDebug.log = (...args: unknown[]) => {
      capturedDebug.push(format(...args));
    };
  });

  after(() => {
    createDebug.disable();
    createDebug.log = originalDebugLog;
  });

  beforeEach(() => {
    capturedDebug.length = 0;
  });

  it('should keep body-parser 400 with a fixed safe message', async () => {
    const ctx = makeCtx();
    // Shape of co-body/http-errors failures: status with untrusted message
    const bodyError = Object.assign(new SyntaxError('evil08a in body'), {
      status: 400,
      expose: true,
      body: 'raw-body-08a',
    });

    await outerErrorMiddleware(ctx, () => Promise.reject(bodyError));

    expect(ctx.status, 'to be', 400);
    expect(ctx.body, 'to equal', { err: 'Bad Request' });
  });

  it('should keep body-parser 413 with a fixed safe message', async () => {
    const ctx = makeCtx();
    const bodyError = Object.assign(new Error('request entity too large'), {
      status: 413,
      expose: true,
    });

    await outerErrorMiddleware(ctx, () => Promise.reject(bodyError));

    expect(ctx.status, 'to be', 413);
    expect(ctx.body, 'to equal', { err: 'Content Too Large' });
  });

  it('should delegate public exceptions to the shared reporting path', async () => {
    const ctx = makeCtx();

    await outerErrorMiddleware(ctx, () => Promise.reject(new ValidationException('v08wrap')));

    expect(ctx.status, 'to be', 422);
    expect(ctx.body, 'to equal', { err: 'v08wrap' });
  });

  it('should delegate unexpected errors to the shared reporting path', async () => {
    const ctx = makeCtx();

    await outerErrorMiddleware(ctx, () =>
      Promise.reject(new Error('boom08wrap SELECT * FROM users')),
    );

    expect(ctx.status, 'to be', 500);
    expect(ctx.body, 'to equal', { err: 'Internal Server Error' });
    expect(capturedDebug.join('\n'), 'not to contain', 'boom08wrap');
  });

  it('should pass successful requests through untouched', async () => {
    const ctx = makeCtx();
    let nextCalled = false;

    await outerErrorMiddleware(ctx, () => {
      nextCalled = true;
    });

    expect(nextCalled, 'to be', true);
    expect(ctx.status, 'to be', 0);
    expect(ctx.body, 'to be', null);
  });

  it('should not throw a second exception for null', async () => {
    const ctx = makeCtx();

    await outerErrorMiddleware(ctx, () => Promise.reject(null));

    expect(ctx.status, 'to be', 500);
    expect(ctx.body, 'to equal', { err: 'Internal Server Error' });
  });
});
