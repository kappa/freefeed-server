// Redaction of request credentials for access logging and diagnostics.
//
// Query strings and fragments are dropped entirely (session JWTs travel in
// `?authToken=` and socket `?token=`); password-reset tokens in
// `/vN/passwords/<token>` paths are masked. Anything unparseable fails
// closed to '[unparseable-url]'; the raw input is never returned.

const UNPARSEABLE_URL = '[unparseable-url]';
const REDACTED = '[redacted]';

const PASSWORDS_PATH_RE = /^\/v([0-9]+)\/passwords\/.+/is;

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'cookie',
  'x-authentication-token',
  'referer',
]);

export function safeRequestPath(rawUrl: string): string {
  if (typeof rawUrl !== 'string') {
    return UNPARSEABLE_URL;
  }

  let pathname: string;

  try {
    // Fixed dummy origin: only the path is ever kept, query and hash are dropped
    ({ pathname } = new URL(rawUrl, 'http://localhost'));
  } catch {
    return UNPARSEABLE_URL;
  }

  let decoded: string;

  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return UNPARSEABLE_URL;
  }

  // Match on the decoded path so encoded reset tokens cannot slip through,
  // but return a safely serialized path, never the decoded input
  const match = PASSWORDS_PATH_RE.exec(decoded);

  if (match) {
    return `/v${match[1]}/passwords/${REDACTED}`;
  }

  return pathname;
}

export function safeRequestSummary(ctx: {
  request: { method: string; url: string };
  state?: { id?: string };
}): { method: string; path: string; requestId: string } {
  return {
    method: ctx.request.method,
    path: safeRequestPath(ctx.request.url),
    requestId: ctx.state?.id ?? '-',
  };
}

export type RavenDataLike = {
  request?: {
    method?: unknown;
    url?: unknown;
    headers?: Record<string, string | string[] | undefined> | undefined;
    query_string?: unknown;
    cookies?: unknown;
    data?: unknown;
  };
  breadcrumbs?: {
    values?: ({ data?: { url?: unknown } | undefined } | undefined)[] | undefined;
  };
  [key: string]: unknown;
};

// Raven (Sentry) dataCallback: strip request credentials from the error
// payload while leaving stack, level, tags and other diagnostics intact.
export function sanitizeRavenData<T extends RavenDataLike>(data: T): T {
  const { request } = data;

  if (request) {
    if (request.headers) {
      const scrubbed: Record<string, string | string[] | undefined> = {};

      for (const [name, value] of Object.entries(request.headers)) {
        if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) {
          scrubbed[name] = value;
        }
      }

      request.headers = scrubbed;
    }

    if (request.query_string !== undefined) {
      request.query_string = {};
    }

    if (request.cookies !== undefined) {
      request.cookies = {};
    }

    if (request.data !== undefined) {
      request.data = `[${REDACTED}]`;
    }

    if (typeof request.url === 'string') {
      request.url = sanitizeLoggedUrl(request.url);
    }
  }

  const breadcrumbs = data.breadcrumbs?.values;

  if (Array.isArray(breadcrumbs)) {
    for (const crumb of breadcrumbs) {
      if (crumb?.data && typeof crumb.data.url === 'string') {
        crumb.data.url = sanitizeLoggedUrl(crumb.data.url);
      }
    }
  }

  return data;
}

function sanitizeLoggedUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // The host is kept for diagnostics; userinfo never survives .host
    return `${parsed.protocol}//${parsed.host}${safeRequestPath(parsed.pathname)}`;
  } catch {
    // Relative or protocol-relative URL: keep the safe path only
    return safeRequestPath(url);
  }
}
