import { promises as fsPromises, readFileSync } from 'fs';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';

import { after, before, beforeEach, describe, it } from 'mocha';
import { type Context } from 'koa';
import Application from 'koa';
import expect from 'unexpected';

import {
  SAFE_OUTBOUND_MAX_REDIRECTS,
  SafeOutboundError,
  safeOutboundRequest,
  setSafeOutboundTestHooks,
  type OutboundPolicy,
} from '../../../app/support/safe-outbound-request';
import { downloadURL } from '../../../app/support/download-url';
import { MockHTTPServer } from '../../functional/functional_test_helper';

const FIXTURE_HOST = 'outbound-fixture.test';
const MIXED_HOST = 'mixed-fixture.test';
const PENDING_DNS_HOST = 'pending-dns-fixture.test';
const TLS_HOST = 'tls-outbound-fixture.test';
// Hostnames whose answers use non-global IANA special-purpose ranges.
const SPECIAL_V6_HOSTS: Record<string, string> = {
  'nat64local-fixture.test': '64:ff9b:1::c000:201',
  'docrange-fixture.test': '3fff::1',
  'srv6-fixture.test': '5f00::1',
  'dummy-fixture.test': '100:0:0:1::1',
};
// Hostnames whose answers use IANA-reserved IPv6 space outside 2000::/3.
const RESERVED_V6_HOSTS: Record<string, string> = {
  'reserved64-fixture.test': '64:ff9b:2::1',
  'reserved5f-fixture.test': '5f01::1',
  'reserved100-fixture.test': '100:0:0:2::1',
};
// A global unicast placeholder the tests assert on; the connector seam
// redirects the actual dial to the local fixture, so it is never dialed.
const PUBLIC_DIAL_ADDRESS = '93.184.216.34';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Gate for the reset-on-signal fixture, armed by its test.
let resetGate: Promise<void> = Promise.resolve();

function stalledStream(): Readable {
  let sent = false;

  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push('first-chunk');
      }
      // Never pushes null: the body stalls until the socket goes away.
    },
  });
}

function streamOfLength(length: number, chunkSize = 1024): Readable {
  let bytesLeft = length;
  const chunk = Buffer.alloc(Math.min(chunkSize, length));

  return new Readable({
    read() {
      if (bytesLeft <= 0) {
        this.push(null);
      } else {
        const size = Math.min(chunk.length, bytesLeft);
        bytesLeft -= size;
        this.push(size === chunk.length ? chunk : chunk.subarray(0, size));
      }
    },
  });
}

describe('safeOutboundRequest', () => {
  const hits: string[] = [];
  const hostHeaders: string[] = [];
  const resolves: string[] = [];
  const dials: { address: string; port: number; hostname: string }[] = [];
  // Release callbacks for resolvers the test holds pending on purpose.
  const pendingResolves: ((addresses: string[]) => void)[] = [];
  const dialedSockets: Socket[] = [];

  const server = new MockHTTPServer(async (ctx: Context) => {
    const { path } = ctx;

    hits.push(path);
    hostHeaders.push(ctx.headers.host ?? '');

    const chainMatch = /^\/r\/(\d+)$/.exec(path);

    if (chainMatch && Number(chainMatch[1]) < 8) {
      ctx.status = 302;
      ctx.set('Location', `/r/${Number(chainMatch[1]) + 1}`);
    } else if (path === '/rel') {
      ctx.status = 302;
      ctx.set('Location', '/file.txt');
    } else if (path === '/to-private') {
      ctx.status = 302;
      ctx.set('Location', `http://127.0.0.1:${server.port}/file.txt`);
    } else if (path === '/loop') {
      ctx.status = 302;
      ctx.set('Location', '/loop');
    } else if (path === '/allowed/start') {
      ctx.status = 302;
      ctx.set('Location', '/denied');
    } else if (path === '/slow') {
      await sleep(1000);
      ctx.body = 'too slow';
    } else if (path === '/big') {
      ctx.status = 200;
      ctx.response.type = 'application/octet-stream';
      ctx.body = streamOfLength(4096);
    } else if (path === '/drip') {
      ctx.status = 200;
      ctx.response.type = 'text/plain';
      ctx.body = stalledStream();
    } else if (path === '/reset-on-signal') {
      // Headers and a partial chunk go out, then the socket is destroyed
      // once the test releases the gate: an upstream reset mid-body.
      ctx.respond = false;
      ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      ctx.res.write('partial-bytes');
      await resetGate;
      ctx.res.destroy();
    } else if (path === '/file.txt') {
      ctx.status = 200;
      ctx.response.type = 'text/plain';
      ctx.body = 'Fixture file body';
    } else if (path === '/pic.jpg') {
      ctx.status = 200;
      ctx.response.type = 'image/jpeg';
      ctx.body = 'fake-jpeg-bytes';
    } else {
      ctx.status = 404;
      ctx.body = 'Not found';
    }
  });

  let tlsPort = 0;
  let tlsServer: https.Server | null = null;

  const fixtureURL = (path: string) => `http://${FIXTURE_HOST}:${server.port}${path}`;

  const testPolicy = (overrides: Partial<OutboundPolicy> = {}): OutboundPolicy => ({
    timeoutMs: 5000,
    maxRedirects: SAFE_OUTBOUND_MAX_REDIRECTS,
    maxBytes: 1024 * 1024,
    allowURL: () => true,
    ...overrides,
  });

  async function fetchText(url: string, policy: OutboundPolicy) {
    const response = await safeOutboundRequest(url, policy);

    try {
      const chunks: Buffer[] = [];

      for await (const chunk of response.body) {
        chunks.push(chunk as Buffer);
      }

      return { response, text: Buffer.concat(chunks).toString('utf8') };
    } finally {
      response.cancel();
    }
  }

  async function expectOutboundError(promise: Promise<unknown>, code: string) {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );

    expect(err, 'to be a', SafeOutboundError);
    expect((err as SafeOutboundError).code, 'to be', code);
  }

  before(async () => {
    await server.start();

    const tlsApp = new Application();
    tlsApp.use((ctx: Context) => {
      ctx.body = 'tls fixture';
    });
    tlsServer = https.createServer(
      {
        key: readFileSync('test/fixtures/safe-outbound-test-key.pem'),
        cert: readFileSync('test/fixtures/safe-outbound-test-cert.pem'),
      },
      tlsApp.callback(),
    );
    await new Promise<void>((resolve) => tlsServer?.listen(0, '127.0.0.1', resolve));
    tlsPort = (tlsServer.address() as { port: number }).port;

    setSafeOutboundTestHooks({
      // eslint-disable-next-line require-await -- async to satisfy the hook signature
      resolveHost: async (hostname: string) => {
        resolves.push(hostname);

        if (hostname === FIXTURE_HOST || hostname === TLS_HOST) {
          return [PUBLIC_DIAL_ADDRESS];
        }

        if (hostname === MIXED_HOST) {
          return [PUBLIC_DIAL_ADDRESS, '10.0.0.1'];
        }

        if (hostname === PENDING_DNS_HOST) {
          // Never settles on its own: the test releases it explicitly.
          return new Promise<string[]>((resolve) => {
            pendingResolves.push(resolve);
          });
        }

        if (hostname in SPECIAL_V6_HOSTS) {
          return [SPECIAL_V6_HOSTS[hostname]];
        }

        if (hostname in RESERVED_V6_HOSTS) {
          return [RESERVED_V6_HOSTS[hostname]];
        }

        return null;
      },
      createConnection: (address: string, port: number, hostname: string) => {
        dials.push({ address, port, hostname });

        if (hostname === TLS_HOST) {
          const socket = tls.connect({ host: '127.0.0.1', port: tlsPort, servername: hostname });
          dialedSockets.push(socket);
          return socket;
        }

        if (hostname === FIXTURE_HOST || hostname === MIXED_HOST) {
          const socket = net.connect({ host: '127.0.0.1', port });
          dialedSockets.push(socket);
          return socket;
        }

        throw new Error(`Unexpected test dial: ${hostname}`);
      },
    });
  });

  after(async () => {
    setSafeOutboundTestHooks(null);
    await server.stop();
    await new Promise((resolve) => tlsServer?.close(resolve));
  });

  beforeEach(() => {
    hits.length = 0;
    hostHeaders.length = 0;
    resolves.length = 0;
    dials.length = 0;
    pendingResolves.length = 0;
    dialedSockets.length = 0;
  });

  it('should fetch a fixture URL through the pinned validated address', async () => {
    const { response, text } = await fetchText(fixtureURL('/file.txt'), testPolicy());

    expect(response.status, 'to be', 200);
    expect(text, 'to be', 'Fixture file body');
    expect(resolves, 'to equal', [FIXTURE_HOST]);
    expect(dials, 'to have length', 1);
    expect(dials[0].address, 'to be', PUBLIC_DIAL_ADDRESS);
    expect(dials[0].port, 'to be', server.port);
    expect(hostHeaders, 'to equal', [`${FIXTURE_HOST}:${server.port}`]);
    expect(hits, 'to equal', ['/file.txt']);
  });

  for (const raw of [
    `http://127.0.0.1:${8080}/file.txt`,
    'http://10.0.0.1/',
    'http://[::1]/',
    'http://2130706433/',
    'http://0x7f.0.0.1/',
  ]) {
    it(`should reject private literal ${raw} without dialing`, async () => {
      await expectOutboundError(safeOutboundRequest(raw, testPolicy()), 'policy');
      expect(dials, 'to be empty');
      expect(resolves, 'to be empty');
      expect(hits, 'to be empty');
    });
  }

  it('should reject URLs with credentials without dialing', async () => {
    await expectOutboundError(
      safeOutboundRequest(`http://user@${FIXTURE_HOST}:${server.port}/file.txt`, testPolicy()),
      'policy',
    );
    expect(dials, 'to be empty');
    expect(hits, 'to be empty');
  });

  it('should reject non-http(s) URLs without dialing', async () => {
    await expectOutboundError(
      safeOutboundRequest(`ftp://${FIXTURE_HOST}/file.txt`, testPolicy()),
      'policy',
    );
    expect(dials, 'to be empty');
  });

  it('should reject mixed public/private DNS answers without dialing', async () => {
    await expectOutboundError(
      safeOutboundRequest(`http://${MIXED_HOST}:${server.port}/file.txt`, testPolicy()),
      'policy',
    );
    expect(resolves, 'to equal', [MIXED_HOST]);
    expect(dials, 'to be empty');
    expect(hits, 'to be empty');
  });

  for (const hostname of Object.keys(SPECIAL_V6_HOSTS)) {
    it(`should deny special-use IPv6 answer for ${hostname} without dialing`, async () => {
      await expectOutboundError(
        safeOutboundRequest(`http://${hostname}:${server.port}/file.txt`, testPolicy()),
        'policy',
      );
      expect(resolves, 'to equal', [hostname]);
      expect(dials, 'to be empty');
      expect(hits, 'to be empty');
    });
  }

  for (const hostname of Object.keys(RESERVED_V6_HOSTS)) {
    it(`should deny reserved IPv6 answer for ${hostname} without dialing`, async () => {
      await expectOutboundError(
        safeOutboundRequest(`http://${hostname}:${server.port}/file.txt`, testPolicy()),
        'policy',
      );
      expect(resolves, 'to equal', [hostname]);
      expect(dials, 'to be empty');
      expect(hits, 'to be empty');
    });
  }

  it('should reject unresolvable hosts without dialing', async () => {
    await expectOutboundError(
      safeOutboundRequest('http://nonexistent-fixture.invalid/', testPolicy()),
      'network',
    );
    expect(dials, 'to be empty');
  });

  it('should follow a relative redirect inside the policy', async () => {
    const { response, text } = await fetchText(fixtureURL('/rel'), testPolicy());

    expect(response.status, 'to be', 200);
    expect(text, 'to be', 'Fixture file body');
    expect(dials, 'to have length', 2);
    expect(hits, 'to equal', ['/rel', '/file.txt']);
  });

  it('should deny a redirect to a private destination before the second dial', async () => {
    await expectOutboundError(
      safeOutboundRequest(fixtureURL('/to-private'), testPolicy()),
      'policy',
    );
    expect(dials, 'to have length', 1);
    expect(hits, 'to equal', ['/to-private']);
  });

  it('should deny a redirect that leaves the consumer policy', async () => {
    const policy = testPolicy({ allowURL: (url: URL) => url.pathname.startsWith('/allowed') });

    await expectOutboundError(safeOutboundRequest(fixtureURL('/allowed/start'), policy), 'policy');
    expect(dials, 'to have length', 1);
    expect(hits, 'to equal', ['/allowed/start']);
  });

  it('should stop after too many redirects', async () => {
    await expectOutboundError(safeOutboundRequest(fixtureURL('/r/0'), testPolicy()), 'redirect');
    expect(dials, 'to have length', SAFE_OUTBOUND_MAX_REDIRECTS + 1);
  });

  it('should detect redirect loops without re-dialing', async () => {
    await expectOutboundError(safeOutboundRequest(fixtureURL('/loop'), testPolicy()), 'redirect');
    expect(dials, 'to have length', 1);
    expect(hits, 'to equal', ['/loop']);
  });

  it('should enforce the total timeout on slow headers', async () => {
    await expectOutboundError(
      safeOutboundRequest(fixtureURL('/slow'), testPolicy({ timeoutMs: 100 })),
      'timeout',
    );
  });

  it('should reject at the deadline while DNS is still pending and never dial after release', async () => {
    const promise = safeOutboundRequest(
      `http://${PENDING_DNS_HOST}:${server.port}/file.txt`,
      testPolicy({ timeoutMs: 100 }),
    );

    await expectOutboundError(promise, 'timeout');
    // The resolver is still holding the request: rejection came from the
    // deadline race, not from eventual DNS settlement.
    expect(pendingResolves, 'to have length', 1);
    expect(dials, 'to be empty');

    // A late settlement must never dial.
    pendingResolves[0]([PUBLIC_DIAL_ADDRESS]);
    await sleep(25);
    expect(dials, 'to be empty');
    expect(hits, 'to be empty');
  });

  it('should tear down upstream when the consumer destroys the body mid-stream', async () => {
    const response = await safeOutboundRequest(fixtureURL('/drip'), testPolicy());

    expect(response.status, 'to be', 200);
    expect(dialedSockets, 'to have length', 1);

    const [upstream] = dialedSockets;
    expect(upstream.destroyed, 'to be', false);

    // This is what Koa does with ctx.body when the downstream response
    // finishes or closes mid-body.
    response.body.destroy();
    await sleep(25);

    expect(upstream.destroyed, 'to be', true);
    response.cancel(); // safe to call after teardown
  });

  it('should stop an oversized chunked body', async () => {
    await expectOutboundError(
      fetchText(fixtureURL('/big'), testPolicy({ maxBytes: 1024 })),
      'too-large',
    );
    expect(hits, 'to equal', ['/big']);
  });

  it('should keep TLS verification enabled and preserve the requested host', async () => {
    const seenOptions: https.RequestOptions[] = [];
    const originalRequest = https.request;
    const httpsModule = https as unknown as { request: typeof https.request };

    httpsModule.request = ((...args: [https.RequestOptions]) => {
      seenOptions.push(args[0]);
      return (originalRequest as (...callArgs: [https.RequestOptions]) => unknown)(...args);
    }) as typeof https.request;

    try {
      await expectOutboundError(
        safeOutboundRequest(`https://${TLS_HOST}:${tlsPort}/`, testPolicy({ timeoutMs: 5000 })),
        'network',
      );
    } finally {
      httpsModule.request = originalRequest;
    }

    // The self-signed fixture certificate is rejected: verification is on.
    expect(seenOptions, 'to have length', 1);
    expect(seenOptions[0].host, 'to be', TLS_HOST);
    expect(dials, 'to have length', 1);
    expect(dials[0].hostname, 'to be', TLS_HOST);
  });

  describe('downloadURL', () => {
    it('should reject private URLs without dialing', async () => {
      await expect(downloadURL('http://127.0.0.1/pic.jpg'), 'to be rejected with', /not allowed/);
      expect(dials, 'to be empty');
      expect(hits, 'to be empty');
    });

    it('should download a fixture file through the policy', async () => {
      const file = await downloadURL(fixtureURL('/pic.jpg'));

      try {
        expect(file.name, 'to be', 'pic.jpg');
        expect(file.type, 'to be', 'image/jpeg');
        expect(file.size, 'to be', 'fake-jpeg-bytes'.length);
        expect(readFileSync(file.path, 'utf8'), 'to be', 'fake-jpeg-bytes');
      } finally {
        await file.unlink();
      }

      expect(() => readFileSync(file.path), 'to throw');
    });

    it('should keep the existing size-limit error', async () => {
      await expect(
        downloadURL(fixtureURL('/pic.jpg'), 2),
        'to be rejected with',
        /File is too large \(15 bytes, max\. 2\)/,
      );
    });

    it('should reject with cleanup when upstream resets mid-body', async () => {
      const openCalls: string[] = [];
      let openCalled!: () => void;
      const openCalledPromise = new Promise<void>((resolve) => {
        openCalled = resolve;
      });
      let releaseOpen!: () => void;
      const releaseOpenPromise = new Promise<void>((resolve) => {
        releaseOpen = resolve;
      });
      let releaseReset!: () => void;
      resetGate = new Promise<void>((resolve) => {
        releaseReset = resolve;
      });

      // Hold the temp-file open so a reset can land exactly where the
      // pipeline is not attached yet; pass every other open through.
      const originalOpen = fsPromises.open;
      const fsModule = fsPromises as unknown as { open: typeof fsPromises.open };
      fsModule.open = (async (...args: [string, ...unknown[]]) => {
        const [filePath] = args;

        if (typeof filePath === 'string' && filePath.startsWith('/tmp/pepyatka')) {
          openCalls.push(filePath);
          openCalled();
          await releaseOpenPromise;
        }

        return (originalOpen as (...callArgs: [string, ...unknown[]]) => unknown)(...args);
      }) as typeof fsPromises.open;

      try {
        const pending = downloadURL(fixtureURL('/reset-on-signal'));
        await openCalledPromise;

        if (hits.length === 0) {
          // Temp file is arranged before the request: let it proceed.
          releaseOpen();
        }

        releaseReset();

        if (hits.length > 0) {
          // The open is held inside the post-response gap: the reset lands
          // while no pipeline owns the body.
          await sleep(25);
          releaseOpen();
        }

        await expect(pending, 'to be rejected');
        expect(openCalls, 'to have length', 1);
        expect(() => readFileSync(openCalls[0]), 'to throw');
      } finally {
        fsModule.open = originalOpen;
      }
    });
  });
});
