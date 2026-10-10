import { type Context } from 'koa';
import { Duration } from 'luxon';

import { ForbiddenException, ValidationException } from '../../../support/exceptions';
import { currentConfig } from '../../../support/app-async-context';
import {
  SAFE_OUTBOUND_MAX_REDIRECTS,
  SafeOutboundError,
  isAllowedByPrefixes,
  safeOutboundRequest,
} from '../../../support/safe-outbound-request';

const fallbackTimeoutMs = 1000;

export async function proxy(ctx: Context) {
  const {
    timeout: timeoutString,
    allowedOrigins,
    allowedUrlPrefixes,
    allowLocalhostOrigins,
    maxResponseBytes,
  } = currentConfig().corsProxy;

  const { origin } = ctx.headers;

  if (typeof origin !== 'string') {
    // If the client is hosted at the same origin as the server, the browser
    // will not send the Origin header. The 'none' value is used to allow these
    // types of requests.
    if (!allowedOrigins.includes('none')) {
      throw new ForbiddenException('Missing origin');
    }
  } else if (
    // Origin header is present, check it validity
    !(
      allowedOrigins.includes(origin) ||
      (allowLocalhostOrigins && /^https?:\/\/localhost(:\d+)?$/.test(origin))
    )
  ) {
    throw new ForbiddenException('Origin not allowed');
  }

  let { url } = ctx.request.query;

  if (Array.isArray(url)) {
    // When there is more than one 'url' parameter, use the first one
    [url] = url;
  }

  if (typeof url !== 'string') {
    throw new ValidationException("Missing 'url' parameter");
  }

  // Exact origin-plus-path match against the configured prefixes. The same
  // predicate runs again on every redirect target inside the transport.
  if (url.includes('\\')) {
    throw new ValidationException('URL not allowed');
  }

  let candidate: URL;

  try {
    candidate = new URL(url);
  } catch {
    throw new ValidationException('URL not allowed');
  }

  if (!isAllowedByPrefixes(candidate, allowedUrlPrefixes)) {
    throw new ValidationException('URL not allowed');
  }

  const timeoutDuration = Duration.fromISO(timeoutString);
  const timeoutMs = timeoutDuration.isValid ? timeoutDuration.toMillis() : fallbackTimeoutMs;

  // Perform the request with timeout. Redirects are followed manually: each
  // hop rechecks the URL prefixes and the public-destination policy.
  let response;

  try {
    response = await safeOutboundRequest(candidate, {
      timeoutMs,
      maxRedirects: SAFE_OUTBOUND_MAX_REDIRECTS,
      maxBytes: maxResponseBytes,
      allowURL: (next: URL) => isAllowedByPrefixes(next, allowedUrlPrefixes),
    });
  } catch (e) {
    if (e instanceof SafeOutboundError && (e.code === 'policy' || e.code === 'redirect')) {
      throw new ValidationException('URL not allowed');
    }

    throw e;
  }

  // Abort the upstream request if the client goes away. The outgoing
  // response (not the already-received request) observes the disconnect.
  const onResClose = () => response.cancel();
  ctx.res.on('close', onResClose);
  // Upstream is already torn down once the body closes; stop listening.
  response.body.on('close', () => {
    ctx.res.off('close', onResClose);
  });

  // Copying to the client:
  // 1. The response status code
  ctx.status = response.status;

  // 2. Some of response headers that we want to pass to the client
  for (const header of ['location', 'content-type', 'content-length', 'content-encoding']) {
    const value = response.headers[header];

    if (value !== undefined) {
      ctx.set(header, Array.isArray(value) ? value.join(', ') : value);
    }
  }

  // 3. And the response body itself
  ctx.body = response.body;
}
