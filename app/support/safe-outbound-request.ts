import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net, { type Socket } from 'node:net';
import { Transform, type Duplex, type Readable } from 'node:stream';
import tls from 'node:tls';

import { Address as IPv6Address } from './ipv6';

export const SAFE_OUTBOUND_MAX_REDIRECTS = 5;

export type OutboundPolicy = {
  timeoutMs: number; // total deadline: DNS, redirects and the streamed body
  maxRedirects: number;
  maxBytes: number;
  allowURL: (url: URL) => boolean; // extra consumer check, rerun on every hop
};

export type SafeOutboundResponse = {
  status: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: Readable; // enforces the deadline and maxBytes while it is consumed
  cancel(): void; // silent teardown of the request, socket, stream and timers
};

export type SafeOutboundErrorCode = 'policy' | 'redirect' | 'timeout' | 'too-large' | 'network';

// Typed, non-secret errors: messages never include resolved addresses.
export class SafeOutboundError extends Error {
  readonly code: SafeOutboundErrorCode;

  constructor(code: SafeOutboundErrorCode, message: string) {
    super(message);
    this.name = 'SafeOutboundError';
    this.code = code;
  }
}

export type SafeOutboundTestHooks = {
  // Replaces DNS for the given hostname; return null/undefined for real DNS.
  // Returned answers go through the same public-address validation.
  resolveHost?: (hostname: string) => Promise<string[] | null | undefined>;
  // Replaces the socket dial; return null/undefined for the default dial.
  createConnection?: (address: string, port: number, hostname: string) => Socket | null | undefined;
};

let testHooks: SafeOutboundTestHooks | null = null;

/**
 * Installs process-wide resolver/connector hooks for tests that use local
 * fixtures. Test-only: production code must never call this. There is no
 * configuration or environment flag that changes destination validation.
 */
export function setSafeOutboundTestHooks(hooks: SafeOutboundTestHooks | null): void {
  testHooks = hooks;
}

// IPv4 ranges that are never valid outbound destinations, as [network, prefix length].
// Covers loopback, private, link-local (incl. cloud metadata), CGNAT, multicast,
// reserved, broadcast and documentation/benchmark ranges.
const V4_DENY: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8 ("this network")
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc01fc400, 24], // 192.31.196.0/24 AS112-v4
  [0xc034c100, 24], // 192.52.193.0/24 AMT
  [0xc0586300, 24], // 192.88.99.0/24 6to4 relay
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved + broadcast
];

function isPublicIPv4(ip: string): boolean {
  const parts = ip.split('.');

  if (parts.length !== 4) {
    return false;
  }

  let addr = 0;

  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const octet = Number(part);

    if (octet > 255) {
      return false;
    }

    addr = addr * 256 + octet;
  }

  return !V4_DENY.some(([network, length]) => addr >>> (32 - length) === network >>> (32 - length));
}

// IPv6 ranges that are never valid outbound destinations. Transition encodings
// (6to4, Teredo, NAT64, mapped documentation space) are denied: their embedded
// IPv4 cannot be equated with a validated destination, except for
// IPv4-mapped addresses whose inner address is classified as IPv4.
const V6_DENY = [
  '::/128', // unspecified
  '::1/128', // loopback
  '::/96', // IPv4-compatible (deprecated)
  '64:ff9b::/96', // NAT64 translation
  '64:ff9b:1::/48', // local-use NAT64 (RFC 8215)
  '100::/64', // discard prefix
  '100:0:0:1::/64', // dummy prefix (RFC 9780)
  '2001::/23', // special-use incl. Teredo
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4 (embeds IPv4)
  '3fff::/20', // documentation range (RFC 9637)
  '5f00::/16', // SRv6 SIDs (RFC 9602)
  'fc00::/7', // unique-local
  'fe80::/10', // link-local
  'fec0::/10', // site-local (deprecated)
  'ff00::/8', // multicast
].map((cidr) => new IPv6Address(cidr));

// Current global-unicast space per the IANA IPv6 registry; every other
// native block is reserved or special-purpose, never a public destination.
const V6_GLOBAL_UNICAST = new IPv6Address('2000::/3');

function isPublicIPv6(ip: string): boolean {
  let addr: IPv6Address;

  try {
    addr = new IPv6Address(ip);
  } catch {
    return false;
  }

  if (addr.isIP4()) {
    // IPv4-mapped: the destination is equivalent to the inner IPv4 address.
    return isPublicIPv4(addr.bytes.slice(12).join('.'));
  }

  if (!V6_GLOBAL_UNICAST.contains(addr)) {
    return false;
  }

  return !V6_DENY.some((deny) => deny.contains(addr));
}

export function isPublicIP(ip: string): boolean {
  if (ip.includes('%')) {
    // IPv6 zone identifier: never a valid outbound destination.
    return false;
  }

  const family = net.isIP(ip);

  if (family === 4) {
    return isPublicIPv4(ip);
  }

  if (family === 6) {
    return isPublicIPv6(ip);
  }

  return false;
}

function bareHostname(hostname: string): string {
  // URL keeps brackets on IPv6 literals; strip them for classification/lookup.
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

// Matches a candidate URL against configured CORS URL prefixes: same origin
// plus a literal path prefix, after WHATWG normalization. Invalid or
// credential/query/fragment-bearing config prefixes never match.
export function isAllowedByPrefixes(candidate: URL, allowedPrefixes: string[]): boolean {
  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') {
    return false;
  }

  if (candidate.username !== '' || candidate.password !== '') {
    return false;
  }

  if (/%(2f|5c)/i.test(candidate.pathname)) {
    // Encoded separators that an upstream could decode differently.
    return false;
  }

  for (const rawPrefix of allowedPrefixes) {
    let prefix: URL;

    try {
      prefix = new URL(rawPrefix);
    } catch {
      continue;
    }

    if (prefix.protocol !== 'http:' && prefix.protocol !== 'https:') {
      continue;
    }

    if (prefix.username !== '' || prefix.password !== '') {
      continue;
    }

    if (prefix.search !== '' || prefix.hash !== '') {
      continue;
    }

    if (candidate.origin !== prefix.origin) {
      continue;
    }

    if (!candidate.pathname.startsWith(prefix.pathname)) {
      continue;
    }

    return true;
  }

  return false;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type PinnedTarget = { address: string; family: 4 | 6 };

async function resolveTarget(url: URL): Promise<PinnedTarget> {
  const { hostname } = url;

  if (hostname === '') {
    throw new SafeOutboundError('policy', 'URL host is not allowed');
  }

  const bare = bareHostname(hostname);

  if (bare.includes('%')) {
    throw new SafeOutboundError('policy', 'URL host is not allowed');
  }

  const literalFamily = net.isIP(bare);

  if (literalFamily === 4 || literalFamily === 6) {
    // Direct literal (WHATWG parsing already normalized odd IPv4 forms).
    if (!isPublicIP(bare)) {
      throw new SafeOutboundError('policy', 'URL host is not allowed');
    }

    return { address: bare, family: literalFamily };
  }

  const hooked = await testHooks?.resolveHost?.(hostname);
  let addresses: string[];

  if (hooked != null) {
    addresses = hooked;
  } else {
    let records: dns.LookupAddress[];

    try {
      records = await dns.promises.lookup(hostname, { all: true });
    } catch {
      throw new SafeOutboundError('network', 'Could not resolve the URL host');
    }

    addresses = records.map((r) => r.address);
  }

  if (addresses.length === 0) {
    throw new SafeOutboundError('policy', 'URL host is not allowed');
  }

  for (const address of addresses) {
    if (!isPublicIP(address)) {
      throw new SafeOutboundError('policy', 'URL host is not allowed');
    }
  }

  const family = net.isIP(addresses[0]);

  if (family === 4 || family === 6) {
    return { address: addresses[0], family };
  }

  throw new SafeOutboundError('policy', 'URL host is not allowed');
}

// A lookup that can only return the already-validated pinned address, so the
// connection never re-resolves or uses an unvalidated answer.
function pinnedLookup(expectedHost: string, target: PinnedTarget) {
  return (
    hostname: string,
    options: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family?: number,
    ) => void,
  ) => {
    if (hostname !== expectedHost) {
      callback(new Error('Unexpected host lookup'), '', 0);
      return;
    }

    if (typeof options === 'object' && options !== null && options.all) {
      callback(null, [{ address: target.address, family: target.family }], 0);
    } else {
      callback(null, target.address, target.family);
    }
  };
}

function firstHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

type DialHook = () => Socket | null | undefined;

function wireHookedSocket(
  socket: Socket,
  callback?: (err: Error | null, stream: Duplex) => void,
): void {
  // Mirror the default agent: signal readiness on connect (TLS: after the
  // handshake). Socket errors flow to the request through the socket itself.
  const readyEvent = socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect';
  socket.once(readyEvent, () => callback?.(null, socket));
}

// Test-only agents that redirect the dial through the connector seam. One
// fresh instance per hop, never shared, keep-alive off: no pooled socket can
// escape the per-hop policy. Production always uses `agent: false`.
class TestHookHttpAgent extends http.Agent {
  dial: DialHook = () => null;

  createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const hooked = this.dial();

    if (hooked) {
      wireHookedSocket(hooked, callback);
      return hooked;
    }

    return super.createConnection(options, callback);
  }
}

class TestHookHttpsAgent extends https.Agent {
  dial: DialHook = () => null;

  createConnection(
    options: https.RequestOptions,
    callback?: (err: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    const hooked = this.dial();

    if (hooked) {
      wireHookedSocket(hooked, callback);
      return hooked;
    }

    return super.createConnection(options, callback);
  }
}

export async function safeOutboundRequest(
  input: string | URL,
  policy: OutboundPolicy,
): Promise<SafeOutboundResponse> {
  let current: URL;

  try {
    current = typeof input === 'string' ? new URL(input) : new URL(input.href);
  } catch {
    throw new SafeOutboundError('policy', 'URL is not valid');
  }

  const deadline = Date.now() + policy.timeoutMs;
  let timedOut = false;
  let liveRequest: http.ClientRequest | null = null;
  let liveIncoming: http.IncomingMessage | null = null;
  let liveBody: Transform | null = null;
  // Rejects the in-flight DNS wait when the deadline fires first. DNS has
  // no live handles to destroy, so without this the caller would stay
  // pending until the resolver settles on its own.
  let rejectPendingResolve: ((err: Error) => void) | null = null;

  const timeoutError = () => new SafeOutboundError('timeout', 'Upstream request timed out');

  const timer = setTimeout(() => {
    timedOut = true;
    const err = timeoutError();
    rejectPendingResolve?.(err);
    rejectPendingResolve = null;
    liveRequest?.destroy(err);
    liveIncoming?.destroy(err);
    liveBody?.destroy(err);
  }, policy.timeoutMs);

  // The timer lives until the returned body is fully consumed or cancelled.
  const clearTimer = () => clearTimeout(timer);

  const cancel = () => {
    clearTimer();
    liveRequest?.destroy();
    liveIncoming?.destroy();
    liveBody?.destroy();
    liveRequest = null;
    liveIncoming = null;
    liveBody = null;
  };

  const checkTimeout = () => {
    if (timedOut || Date.now() >= deadline) {
      throw timeoutError();
    }
  };

  // Races DNS against the total deadline. DNS has no live handles to
  // destroy, so the timer settles this wait directly; a late settlement
  // is discarded and can never dial (the race already observed it, so a
  // late failure cannot surface unhandled either).
  const resolveBeforeDeadline = async (url: URL): Promise<PinnedTarget> => {
    const deadlineRejection = new Promise<never>((_resolve, reject) => {
      rejectPendingResolve = reject;
    });

    try {
      const target = await Promise.race([resolveTarget(url), deadlineRejection]);
      return target;
    } finally {
      rejectPendingResolve = null;
    }
  };

  try {
    const visited = new Set<string>();
    let redirects = 0;

    for (;;) {
      checkTimeout();

      if (!policy.allowURL(current)) {
        throw new SafeOutboundError('policy', 'URL is not allowed');
      }

      if (current.protocol !== 'http:' && current.protocol !== 'https:') {
        throw new SafeOutboundError('policy', 'URL protocol is not allowed');
      }

      if (current.username !== '' || current.password !== '') {
        throw new SafeOutboundError('policy', 'URL must not contain credentials');
      }

      if (visited.has(current.href)) {
        throw new SafeOutboundError('redirect', 'Redirect loop detected');
      }

      visited.add(current.href);

      // Resolve and validate before any socket dial. The wait loses to the
      // total deadline first; a late settlement still must never dial, so
      // the deadline is rechecked right after DNS.
      // eslint-disable-next-line no-await-in-loop
      const target = await resolveBeforeDeadline(current);
      checkTimeout();

      const isHttps = current.protocol === 'https:';
      let port = isHttps ? 443 : 80;

      if (current.port !== '') {
        port = Number(current.port);
      }

      const expectedHost = current.hostname;

      const requestOptions: https.RequestOptions = {
        protocol: current.protocol,
        host: bareHostname(expectedHost),
        port,
        path: `${current.pathname}${current.search}`,
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity' },
        agent: false, // no pooled sockets that could escape the policy
        lookup: pinnedLookup(expectedHost, target),
      };

      if (testHooks?.createConnection) {
        const dial = () => testHooks?.createConnection?.(target.address, port, expectedHost);
        const hopAgent = isHttps ? new TestHookHttpsAgent() : new TestHookHttpAgent();
        hopAgent.dial = dial;
        requestOptions.agent = hopAgent;
      }

      // eslint-disable-next-line no-await-in-loop
      const { status, statusMessage, headers, incoming, request } = await new Promise<{
        status: number;
        statusMessage: string;
        headers: Record<string, string | string[] | undefined>;
        incoming: http.IncomingMessage;
        request: http.ClientRequest;
      }>((resolve, reject) => {
        const onError = (err: Error) => {
          liveRequest = null;
          reject(
            err instanceof SafeOutboundError
              ? err
              : new SafeOutboundError('network', 'Upstream request failed'),
          );
        };

        const req = isHttps ? https.request(requestOptions) : http.request(requestOptions);

        req.on('response', (res: http.IncomingMessage) => {
          liveRequest = null;
          liveIncoming = res;
          // Attached synchronously so a socket error can never arrive unhandled.
          res.on('error', onError);
          const responseHeaders: Record<string, string | string[] | undefined> = {};

          for (const [name, value] of Object.entries(res.headers)) {
            responseHeaders[name] = value;
          }

          resolve({
            status: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: responseHeaders,
            incoming: res,
            request: req,
          });
        });

        liveRequest = req;
        req.on('error', onError);
        req.end();
      });

      liveIncoming = incoming;

      if (!REDIRECT_STATUSES.has(status)) {
        const received = { bytes: 0 };
        const body = new Transform({
          transform(chunk, _encoding, callback) {
            received.bytes += chunk.length;

            if (received.bytes > policy.maxBytes) {
              callback(new SafeOutboundError('too-large', 'Response body is too large'));
              request.destroy();
              incoming.destroy();
              return;
            }

            callback(null, chunk);
          },
        });

        liveBody = body;
        liveRequest = null; // fully sent; teardown now targets the streams
        incoming.on('error', (err: Error) => body.destroy(err));
        body.on('close', () => {
          clearTimer();
          // Tear down the upstream side even when the consumer destroys the
          // body first (Koa does this on downstream disconnect): a destroyed
          // body never resumes the piped source, so the upstream socket
          // would otherwise linger without its deadline.
          request.destroy();
          incoming.destroy();
          liveIncoming = null;
          liveBody = null;
        });
        incoming.pipe(body);

        return { status, statusMessage, headers, body, cancel };
      }

      // A redirect hop: never follow automatically, validate the next URL first.
      request.destroy();
      incoming.destroy();
      liveRequest = null;
      liveIncoming = null;

      if (redirects >= policy.maxRedirects) {
        throw new SafeOutboundError('redirect', 'Too many redirects');
      }

      const location = firstHeader(headers, 'location');

      if (!location) {
        throw new SafeOutboundError('redirect', 'Redirect response is missing a location');
      }

      try {
        current = new URL(location, current);
      } catch {
        throw new SafeOutboundError('redirect', 'Redirect location is not valid');
      }

      redirects += 1;
    }
  } catch (err) {
    cancel();
    throw err;
  }
}
