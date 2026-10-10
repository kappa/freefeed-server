import http from 'node:http';
import { type Socket } from 'node:net';

import { after, before, describe, it } from 'mocha';
import expect from 'unexpected';
import { type Context } from 'koa';

import { getSingleton } from '../../app/app';
import { withModifiedConfig } from '../helpers/with-modified-config';

import {
  performJSONRequest,
  MockHTTPServer,
  safeOutboundFixtureOrigin,
  withSafeOutboundFixture,
} from './functional_test_helper';

const FIXTURE_HOST = 'cors-proxy-fixture.test';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Server-side sockets of the drip fixture, in request order.
const upstreamSockets: Socket[] = [];

const server = new MockHTTPServer((ctx: Context) => {
  const {
    request: { url },
  } = ctx;

  if (url === '/example.txt') {
    ctx.status = 200;
    ctx.response.type = 'text/plain';
    ctx.body = 'Example text';
  } else if (url === '/example/drip') {
    // Headers plus a first chunk, then a slow drip that never ends: the
    // upstream connection stays genuinely busy (no idle timeout) until
    // the proxy tears it down.
    ctx.respond = false;
    upstreamSockets.push(ctx.req.socket);
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain' });
    ctx.res.write('first-chunk');
    const drip = setInterval(() => {
      if (!ctx.res.destroyed) {
        ctx.res.write('x');
      }
    }, 200);
    ctx.res.on('close', () => clearInterval(drip));
  } else if (url === '/example/rel') {
    ctx.status = 302;
    ctx.set('Location', '/example.txt');
  } else if (url === '/example/to-other-path') {
    ctx.status = 302;
    ctx.set('Location', `${safeOutboundFixtureOrigin(server, FIXTURE_HOST)}/other`);
  } else if (url === '/example/to-other-origin') {
    ctx.status = 302;
    ctx.set('Location', 'http://other-origin.test/example.txt');
  } else {
    ctx.status = 404;
    ctx.response.type = 'text/plain';
    ctx.body = 'Not found';
  }
});

const fixtureURL = (path: string) => `${safeOutboundFixtureOrigin(server, FIXTURE_HOST)}${path}`;

describe('CORS proxy', () => {
  before(() => server.start());
  after(() => server.stop());

  withSafeOutboundFixture(FIXTURE_HOST);

  withModifiedConfig(() => ({
    corsProxy: {
      allowedOrigins: ['none', 'http://goodorigin.net'],
      allowedUrlPrefixes: [`${safeOutboundFixtureOrigin(server, FIXTURE_HOST)}/example`],
    },
  }));

  it(`should return error if called without url`, async () => {
    const resp = await performJSONRequest('GET', '/v2/cors-proxy');
    expect(resp, 'to equal', { __httpCode: 422, err: "Missing 'url' parameter" });
  });

  it(`should return error if called with not allowed url`, async () => {
    const url = fixtureURL('/index.html');
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to equal', { __httpCode: 422, err: 'URL not allowed' });
  });

  it(`should return error if called with invalid origin`, async () => {
    const url = fixtureURL('/example.txt');
    const resp = await performJSONRequest(
      'GET',
      `/v2/cors-proxy?url=${encodeURIComponent(url)}`,
      null,
      { Origin: 'https://badorigin.net' },
    );
    expect(resp, 'to equal', { __httpCode: 403, err: 'Origin not allowed' });
  });

  it(`should call with allowed url and without origin`, async () => {
    const url = fixtureURL('/example.txt');
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });

  it(`should call with allowed (but non-existing) url and without origin`, async () => {
    const url = fixtureURL('/example.pdf');
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to satisfy', { __httpCode: 404, textResponse: 'Not found' });
  });

  it(`should call with allowed url and origin`, async () => {
    const url = fixtureURL('/example.txt');
    const resp = await performJSONRequest(
      'GET',
      `/v2/cors-proxy?url=${encodeURIComponent(url)}`,
      null,
      { Origin: 'http://goodorigin.net' },
    );
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });

  it(`should call with allowed url and localhost origin`, async () => {
    const url = fixtureURL('/example.txt');
    const resp = await performJSONRequest(
      'GET',
      `/v2/cors-proxy?url=${encodeURIComponent(url)}`,
      null,
      { Origin: 'http://localhost:8080' },
    );
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });

  it(`should follow a relative redirect inside the allowed prefix`, async () => {
    const url = fixtureURL('/example/rel');
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to satisfy', { __httpCode: 200, textResponse: 'Example text' });
  });

  it(`should deny a redirect outside the allowed path`, async () => {
    const url = fixtureURL('/example/to-other-path');
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to equal', { __httpCode: 422, err: 'URL not allowed' });
  });

  it(`should deny a redirect to another origin`, async () => {
    const url = fixtureURL('/example/to-other-origin');
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to equal', { __httpCode: 422, err: 'URL not allowed' });
  });

  it(`should close upstream when the client disconnects mid-body`, async () => {
    upstreamSockets.length = 0;

    const app = await getSingleton();
    const target = fixtureURL('/example/drip');
    const proxyUrl = `${app.context.config.host}/v2/cors-proxy?url=${encodeURIComponent(target)}`;

    // Abort downstream right after the proxied headers arrive.
    await new Promise<void>((resolve) => {
      const req = http.get(proxyUrl, (res) => {
        res.on('error', () => undefined);
        res.resume();
        req.destroy();
      });
      req.on('error', () => undefined);
      req.on('close', () => resolve());
    });

    expect(upstreamSockets, 'to have length', 1);

    const [upstreamSocket] = upstreamSockets;

    // Bounded wait: the close must arrive promptly after the abort.
    for (let i = 0; i < 200 && !upstreamSocket.destroyed; i++) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(10);
    }

    expect(upstreamSocket.destroyed, 'to be', true);
  });
});

describe('CORS proxy private destinations', () => {
  const privateServer = new MockHTTPServer((ctx: Context) => {
    ctx.status = 200;
    ctx.response.type = 'text/plain';
    ctx.body = 'Private bytes';
  });

  before(() => privateServer.start());
  after(() => privateServer.stop());

  withSafeOutboundFixture(FIXTURE_HOST);

  withModifiedConfig(() => ({
    corsProxy: {
      allowedOrigins: ['none'],
      allowedUrlPrefixes: [`http://127.0.0.1:${privateServer.port}/example`],
    },
  }));

  it(`should deny a private destination even inside an allowed prefix`, async () => {
    const url = `http://127.0.0.1:${privateServer.port}/example.txt`;
    const resp = await performJSONRequest('GET', `/v2/cors-proxy?url=${encodeURIComponent(url)}`);
    expect(resp, 'to equal', { __httpCode: 422, err: 'URL not allowed' });
  });
});
