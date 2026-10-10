import { describe, it } from 'mocha';
import expect from 'unexpected';

import { isAllowedByPrefixes, isPublicIP } from '../../app/support/safe-outbound-request';

describe('isPublicIP', () => {
  const testData: { input: string; result: boolean }[] = [
    // Global public unicast
    { input: '8.8.8.8', result: true },
    { input: '1.1.1.1', result: true },
    { input: '93.184.216.34', result: true },
    { input: '11.0.0.1', result: true },
    { input: '100.128.0.1', result: true },
    { input: '172.32.0.1', result: true },
    { input: '192.167.255.255', result: true },
    { input: '2001:4860:4860::8888', result: true },
    { input: '2606:4700:4700::1111', result: true },
    { input: '2000::1', result: true },
    { input: '2600::1', result: true },
    // IPv4-mapped public IPv4 is equivalent to the inner address
    { input: '::ffff:8.8.8.8', result: true },
    { input: '::ffff:100.128.0.1', result: true },
    // Loopback
    { input: '127.0.0.1', result: false },
    { input: '127.1.2.3', result: false },
    { input: '::1', result: false },
    // Private
    { input: '10.0.0.1', result: false },
    { input: '10.255.255.255', result: false },
    { input: '172.16.0.1', result: false },
    { input: '172.31.255.255', result: false },
    { input: '192.168.1.1', result: false },
    { input: 'fc00::1', result: false },
    { input: 'fd00::1', result: false },
    { input: 'fec0::1', result: false },
    // Link-local (incl. cloud metadata) and unspecified
    { input: '169.254.169.254', result: false },
    { input: '169.254.10.20', result: false },
    { input: 'fe80::1', result: false },
    { input: '0.0.0.0', result: false },
    { input: '::', result: false },
    // CGNAT, multicast, reserved, broadcast
    { input: '100.64.0.1', result: false },
    { input: '100.127.255.255', result: false },
    { input: '224.0.0.1', result: false },
    { input: '239.1.2.3', result: false },
    { input: 'ff02::1', result: false },
    { input: '240.0.0.1', result: false },
    { input: '255.255.255.255', result: false },
    // Documentation, benchmarking and other special-use
    { input: '192.0.2.1', result: false },
    { input: '198.51.100.7', result: false },
    { input: '203.0.113.9', result: false },
    { input: '192.0.0.1', result: false },
    { input: '198.18.0.1', result: false },
    { input: '2001:db8::1', result: false },
    // Transition encodings
    { input: '::ffff:127.0.0.1', result: false },
    { input: '::ffff:10.1.2.3', result: false },
    { input: '::ffff:192.0.2.1', result: false },
    { input: '64:ff9b::808:808', result: false },
    { input: '2002:c000:200::', result: false },
    { input: '2001::1', result: false },
    // Further non-global IANA special-purpose ranges
    { input: '64:ff9b:1::c000:201', result: false },
    { input: '3fff::1', result: false },
    { input: '5f00::1', result: false },
    { input: '100:0:0:1::1', result: false },
    // Only 3fff:f000::1 is adjacent global unicast; the other adjacent
    // blocks (::/8, 4000::/3, 100::/8) are IANA-reserved, never public.
    { input: '64:ff9b:2::1', result: false },
    { input: '3fff:f000::1', result: true },
    { input: '5f01::1', result: false },
    { input: '100:0:0:2::1', result: false },
    // Reserved IPv6 space outside global unicast 2000::/3
    { input: '4000::1', result: false },
    { input: 'c000::1', result: false },
    // Zone identifiers and non-IP input
    { input: 'fe80::1%eth0', result: false },
    { input: 'not-an-ip', result: false },
    { input: '', result: false },
    { input: '2130706433', result: false },
  ];

  for (const t of testData) {
    it(`should classify "${t.input}" as ${t.result ? 'public' : 'not public'}`, () =>
      expect(isPublicIP(t.input), 'to be', t.result));
  }
});

describe('WHATWG-normalized IPv4 literals', () => {
  // The URL parser normalizes decimal/octal/hex forms before classification.
  for (const raw of [
    'http://2130706433/',
    'http://0x7f.0.0.1/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
    'http://127.1/',
  ]) {
    it(`should reject ${raw}`, () => {
      const { hostname } = new URL(raw);
      expect(hostname, 'to be', '127.0.0.1');
      expect(isPublicIP(hostname), 'to be false');
    });
  }
});

describe('isAllowedByPrefixes', () => {
  const prefixes = ['http://good.test/example'];

  const testData: { url: string; prefixes?: string[]; result: boolean }[] = [
    { url: 'http://good.test/example.txt', result: true },
    { url: 'http://good.test/example/nested', result: true },
    // oEmbed-style candidates carry a query string
    { url: 'http://good.test/example?url=http://evil.test/', result: true },
    { url: 'http://good.test/other', result: false },
    { url: 'http://good.test:81/example.txt', result: false },
    { url: 'https://good.test/example.txt', result: false },
    { url: 'http://good.test.attacker.test/example.txt', result: false },
    { url: 'http://attacker.test/http://good.test/example', result: false },
    { url: 'http://user@good.test/example.txt', result: false },
    { url: 'http://user:pass@good.test/example.txt', result: false },
    { url: 'http://good.test@attacker.test/example', result: false },
    { url: 'ftp://good.test/example', result: false },
    // Encoded separators an upstream could decode differently
    { url: 'http://good.test/example%2f.txt', result: false },
    { url: 'http://good.test/example%2F.txt', result: false },
    { url: 'http://good.test/example%5c.txt', result: false },
    // Traversal is judged after WHATWG normalization
    {
      url: 'http://good.test/allowed/../other',
      prefixes: ['http://good.test/allowed'],
      result: false,
    },
    {
      url: 'http://good.test/allowed/x/../y',
      prefixes: ['http://good.test/allowed'],
      result: true,
    },
    // Config prefixes with credentials, query or fragment never match
    {
      url: 'http://good.test/example',
      prefixes: ['http://good.test/example?x=1'],
      result: false,
    },
    {
      url: 'http://good.test/example',
      prefixes: ['http://good.test/example#frag'],
      result: false,
    },
    {
      url: 'http://good.test/example',
      prefixes: ['http://user@good.test/example'],
      result: false,
    },
    { url: 'http://good.test/example', prefixes: ['::::'], result: false },
    { url: 'http://good.test/example', prefixes: ['ftp://good.test/example'], result: false },
    // A second configured prefix can match
    {
      url: 'http://other.test/oembed',
      prefixes: ['http://good.test/example', 'http://other.test/oembed'],
      result: true,
    },
  ];

  for (const t of testData) {
    it(`should ${t.result ? 'allow' : 'deny'} ${t.url}`, () =>
      expect(isAllowedByPrefixes(new URL(t.url), t.prefixes ?? prefixes), 'to be', t.result));
  }
});
