import expect from 'unexpected';
import Raven from 'raven';

import {
  safeRequestPath,
  safeRequestSummary,
  sanitizeRavenData,
} from '../../app/support/safe-request-summary';

describe('safeRequestPath', () => {
  const cases: [string, string, string][] = [
    // [title, raw URL, sentinel that must be absent from the result]
    ['query authToken', '/v1/users/me?authToken=credlog03auth1', 'credlog03auth1'],
    ['socket query token', '/socket.io/?token=credlog03sock1&EIO=4', 'credlog03sock1'],
    [
      'repeated query names',
      '/v1/x?a=1&authToken=credlog03rep1&authToken=credlog03rep2',
      'credlog03rep',
    ],
    ['encoded query name', '/v1/x?%61uthToken=credlog03enc1', 'credlog03enc1'],
    [
      'nested URL in query',
      '/v2/search?qs=https%3A%2F%2Fa.test%2F%3FauthToken%3Dcredlog03nest1',
      'credlog03nest1',
    ],
    ['reset token path', '/v1/passwords/credlog03reset1', 'credlog03reset1'],
    ['reset token path, other version', '/v12/passwords/credlog03reset2', 'credlog03reset2'],
    ['reset token path, mixed case', '/V2/PASSWORDS/credlog03reset3', 'credlog03reset3'],
    ['reset token path, encoded chars', '/v1/passwords/%63redlog03reset4', 'credlog03reset4'],
    ['reset token path, trailing slash', '/v1/passwords/credlog03reset5/', 'credlog03reset5'],
    [
      'reset token path with query',
      '/v1/passwords/credlog03reset6?authToken=credlog03auth2',
      'credlog03',
    ],
    [
      'absolute URL with query',
      'https://h.test/v1/users/me?authToken=credlog03abs1',
      'credlog03abs1',
    ],
    ['fragment is dropped', '/v2/posts?limit=30#credlog03frag1', 'credlog03frag1'],
  ];

  for (const [title, rawUrl, sentinel] of cases) {
    it(`should not retain credentials for ${title}`, () => {
      expect(safeRequestPath(rawUrl), 'not to contain', sentinel);
    });
  }

  it('should keep ordinary paths useful', () => {
    expect(safeRequestPath('/v2/posts'), 'to be', '/v2/posts');
  });

  it('should remove all queries, even without secrets', () => {
    expect(safeRequestPath('/v2/posts?limit=30&offset=0'), 'to be', '/v2/posts');
  });

  it('should mask the reset token segment', () => {
    expect(safeRequestPath('/v1/passwords/some-token'), 'to be', '/v1/passwords/[redacted]');
  });

  it('should keep the tokenless reset route as is', () => {
    expect(safeRequestPath('/v1/passwords'), 'to be', '/v1/passwords');
  });

  it('should fail closed on invalid encodings', () => {
    expect(safeRequestPath('/v1/%E0%A4%A'), 'to be', '[unparseable-url]');
    expect(safeRequestPath('http://['), 'to be', '[unparseable-url]');
  });
});

describe('safeRequestSummary', () => {
  it('should return only method, safe path and request ID', () => {
    const summary = safeRequestSummary({
      request: { method: 'PUT', url: '/v1/passwords/credlog03sum1?authToken=credlog03sum2' },
      state: { id: 'req-1' },
    });

    expect(summary, 'to equal', {
      method: 'PUT',
      path: '/v1/passwords/[redacted]',
      requestId: 'req-1',
    });
    expect(JSON.stringify(summary), 'not to contain', 'credlog03sum');
  });

  it('should fall back to a placeholder request ID', () => {
    const summary = safeRequestSummary({ request: { method: 'GET', url: '/v2/posts' }, state: {} });

    expect(summary.requestId, 'to be', '-');
  });
});

describe('sanitizeRavenData', () => {
  const buildPayload = () => ({
    message: 'boom',
    level: 'error',
    extra: { requestId: 'req-9' },
    exception: { values: [{ type: 'Error', value: 'boom', stacktrace: { frames: [] } }] },
    request: {
      method: 'PUT',
      url: 'http://localhost:31337/v1/passwords/credlog03rvreset?authToken=credlog03rvq1',
      headers: {
        host: 'localhost:31337',
        authorization: 'Bearer credlog03rvhdr1',
        cookie: 'session=credlog03rvcookie1',
        'x-authentication-token': 'credlog03rvlegacy1',
        referer: 'https://h.test/?authToken=credlog03rvref1',
        'user-agent': 'mocha',
      },
      query_string: { authToken: 'credlog03rvq1' },
      cookies: { session: 'credlog03rvcookie1' },
      data: JSON.stringify({ authToken: 'credlog03rvbody1', newPassword: 'pw' }),
    },
    breadcrumbs: {
      values: [
        {
          category: 'http',
          data: {
            method: 'GET',
            url: 'https://api.test/x?authToken=credlog03rvcrumb1',
            status_code: 200,
          },
        },
        { category: 'ui', message: 'click' },
      ],
    },
  });

  it('should strip credentials from request snapshots and HTTP breadcrumbs', () => {
    const sanitized = sanitizeRavenData(buildPayload());
    const serialized = JSON.stringify(sanitized);

    for (const sentinel of [
      'credlog03rvreset',
      'credlog03rvq1',
      'credlog03rvhdr1',
      'credlog03rvcookie1',
      'credlog03rvlegacy1',
      'credlog03rvref1',
      'credlog03rvbody1',
      'credlog03rvcrumb1',
    ]) {
      expect(serialized, 'not to contain', sentinel);
    }
  });

  it('should retain diagnostics and non-credential fields', () => {
    const sanitized = sanitizeRavenData(buildPayload());

    expect(sanitized.request?.method, 'to be', 'PUT');
    expect(sanitized.request?.url, 'to be', 'http://localhost:31337/v1/passwords/[redacted]');
    expect(sanitized.request?.headers?.['user-agent'], 'to be', 'mocha');
    expect(sanitized.request?.headers?.host, 'to be', 'localhost:31337');
    expect(sanitized.request?.query_string, 'to equal', {});
    expect(JSON.stringify(sanitized.breadcrumbs), 'to contain', 'https://api.test/x');
    expect(sanitized.breadcrumbs?.values?.[1], 'to equal', { category: 'ui', message: 'click' });
    expect(sanitized.level, 'to be', 'error');
    expect(sanitized.extra, 'to equal', { requestId: 'req-9' });
    expect(sanitized.exception.values[0].type, 'to be', 'Error');
  });

  it('should pass through payloads without a request', () => {
    expect(sanitizeRavenData({ message: 'hi' }), 'to equal', { message: 'hi' });
  });

  it('should sanitize through the real Raven client pipeline with a stub transport', async () => {
    const querySentinel = 'credlog03pipeq1';
    const resetSentinel = 'credlog03piper1';
    const headerSentinel = 'credlog03pipeh1';

    let captured: Record<string, unknown> | null = null;
    let transportCalls = 0;
    let transportResolve: () => void = () => undefined;
    const transported = new Promise<void>((resolve) => {
      transportResolve = resolve;
    });
    const transport = {
      send: (
        _client: unknown,
        _message: unknown,
        _headers: unknown,
        _eventId: string,
        cb: (err: Error | null, eventId: string) => void,
      ) => {
        transportCalls += 1;
        transportResolve();

        if (typeof cb === 'function') {
          cb(null, 'event-id');
        }
      },
    } as unknown as Raven.transports.Transport;

    const client = new Raven.Client('https://public:private@localhost:9/1', {
      dataCallback: (kwargs: Record<string, unknown>) => {
        captured = sanitizeRavenData(kwargs);
        return captured;
      },
      transport,
    });

    client.captureBreadcrumb({
      category: 'http',
      data: {
        method: 'GET',
        url: `https://api.test/x?authToken=${querySentinel}`,
        status_code: 200,
      },
    });

    client.captureException(new Error('pipe-boom'), {
      req: {
        method: 'PUT',
        url: `/v1/passwords/${resetSentinel}?authToken=${querySentinel}`,
        headers: {
          host: 'localhost:31337',
          authorization: `Bearer ${headerSentinel}`,
          cookie: `session=${headerSentinel}`,
        },
        query: { authToken: querySentinel },
        body: { newPassword: 'pw' },
      },
    } as unknown as Parameters<Raven.Client['captureException']>[1]);
    await transported;

    expect(transportCalls, 'to be', 1);
    expect(captured, 'not to be null');
    const serialized = JSON.stringify(captured);
    expect(serialized, 'not to contain', querySentinel);
    expect(serialized, 'not to contain', resetSentinel);
    expect(serialized, 'not to contain', headerSentinel);
    expect(serialized, 'to contain', '/v1/passwords/[redacted]');
    expect(serialized, 'to contain', 'pipe-boom');
  });
});
