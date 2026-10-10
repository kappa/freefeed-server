import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import { format } from 'util';

import { after, before, beforeEach, describe, it } from 'mocha';
import createDebug from 'debug';
import expect from 'unexpected';

import { getSingleton } from '../../app/app';
import { dbAdapter, PubSub } from '../../app/models';
import { DummyPublisher } from '../../app/pubsub';
import cleanDB from '../dbCleaner';

import {
  type UserCtx,
  createTestUser,
  createUserAsync,
  performJSONRequest,
  performRequest,
} from './functional_test_helper';

const accessLogPath = fileURLToPath(new URL('../../log/test.log', import.meta.url));

async function accessLogSize(): Promise<number> {
  const stat = await fs.stat(accessLogPath).catch(() => null);
  return stat?.size ?? 0;
}

async function readAppendedLog(fromSize: number): Promise<string> {
  const deadline = Date.now() + 5000;

  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.stat(accessLogPath).catch(() => null);

    if (stat && stat.size > fromSize) {
      // eslint-disable-next-line no-await-in-loop
      const handle = await fs.open(accessLogPath, 'r');

      try {
        const buf = Buffer.alloc(stat.size - fromSize);
        // eslint-disable-next-line no-await-in-loop
        await handle.read(buf, 0, buf.length, fromSize);
        return buf.toString('utf8');
      } finally {
        // eslint-disable-next-line no-await-in-loop
        await handle.close();
      }
    }

    if (Date.now() > deadline) {
      throw new Error('timed out waiting for access log append');
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Request log redaction', () => {
  const capturedDebug: string[] = [];
  const originalDebugLog = createDebug.log;

  before(async () => {
    await getSingleton();
    PubSub.setPublisher(new DummyPublisher());
    createDebug.enable('freefeed:request,freefeed:rateLimiter');
    createDebug.log = (...args: unknown[]) => {
      capturedDebug.push(format(...args));
    };
  });

  after(() => {
    createDebug.disable();
    createDebug.log = originalDebugLog;
  });

  beforeEach(async () => {
    await cleanDB(dbAdapter.database);
    capturedDebug.length = 0;
  });

  describe('query JWT in access log', () => {
    let luna: UserCtx;

    beforeEach(async () => {
      luna = await createTestUser('luna');
    });

    it('should still authenticate by query JWT and redact it from the access log', async () => {
      const refererSentinel = 'credlog03funcref1';
      const sizeBefore = await accessLogSize();

      const resp = await performRequest(`/v1/users/me?authToken=${luna.authToken}`, {
        headers: { Referer: `https://h.test/?authToken=${refererSentinel}` },
      });
      expect(resp.status, 'to be', 200);
      expect(await resp.json(), 'to satisfy', { users: { id: luna.user.id } });

      const requestId = resp.headers.get('x-request-id');
      expect(requestId, 'to be a string');

      const chunk = await readAppendedLog(sizeBefore);
      const line = chunk.split('\n').find((l) => requestId !== null && l.includes(requestId));
      expect(line, 'to be a string');
      const logLine = String(line);

      // Useful diagnostics are preserved...
      expect(logLine, 'to contain', '"GET /v1/users/me HTTP/1.1"');
      expect(logLine, 'to contain', ' 200 ');
      expect(logLine, 'to contain', 'ms');
      // ...while credentials are gone
      expect(logLine, 'not to contain', luna.authToken);
      expect(logLine, 'not to contain', 'authToken=');
      expect(logLine, 'not to contain', refererSentinel);
      expect(capturedDebug.join('\n'), 'not to contain', luna.authToken);
    });

    it('should redact an invalid query JWT and reject the request', async () => {
      const invalidToken = 'invalid03jwt1';
      const sizeBefore = await accessLogSize();

      const resp = await performJSONRequest('GET', `/v1/users/me?authToken=${invalidToken}`);
      expect(resp, 'to satisfy', { __httpCode: 401 });

      const chunk = await readAppendedLog(sizeBefore);
      expect(chunk, 'to contain', '/v1/users/me');
      expect(chunk, 'not to contain', invalidToken);
      expect(capturedDebug.join('\n'), 'not to contain', invalidToken);
    });
  });

  describe('reset token path', () => {
    const email = 'luna@example.com';

    async function requestResetToken(userId: string): Promise<string> {
      const resp = await performJSONRequest('POST', '/v1/passwords', { email });
      expect(resp, 'to satisfy', { __httpCode: 200 });

      const row = await dbAdapter
        .database('users')
        .select('reset_password_token')
        .where('uid', userId)
        .first();
      expect(row.reset_password_token, 'to be a string');

      return row.reset_password_token;
    }

    it('should reset by token while masking it in the logs', async () => {
      const luna = await createUserAsync('luna', 'password', { email });
      const token = await requestResetToken(luna.user.id);
      const sizeBefore = await accessLogSize();

      const resp = await performJSONRequest('PUT', `/v1/passwords/${token}`, {
        newPassword: 'password1',
        passwordConfirmation: 'password1',
      });
      expect(resp, 'to satisfy', { __httpCode: 200 });

      const chunk = await readAppendedLog(sizeBefore);
      expect(chunk, 'to contain', '/v1/passwords/[redacted]');
      expect(chunk, 'not to contain', token);
      expect(capturedDebug.join('\n'), 'not to contain', token);
    });

    it('should reject an invalid reset token without logging it', async () => {
      await createUserAsync('luna', 'password', { email });
      const invalidToken = 'invalid03reset1';
      const sizeBefore = await accessLogSize();

      const resp = await performJSONRequest('PUT', `/v1/passwords/${invalidToken}`);
      expect(resp, 'to satisfy', {
        __httpCode: 404,
        err: 'Password reset token not found or has expired',
      });

      const chunk = await readAppendedLog(sizeBefore);
      expect(chunk, 'to contain', '/v1/passwords/[redacted]');
      expect(chunk, 'not to contain', invalidToken);
      expect(capturedDebug.join('\n'), 'not to contain', invalidToken);
    });
  });

  describe('AppToken audit records', () => {
    it('should redact the query from audit records while keeping query auth working', async () => {
      const luna = await createTestUser('luna');
      const token = await dbAdapter.createAppToken({
        userId: luna.user.id,
        title: 'My app',
        scopes: ['read-my-info', 'manage-posts'],
      });
      const probeSentinel = 'credlog03funcprobe1';

      const resp = await performJSONRequest(
        'POST',
        `/v1/posts?authToken=${token.tokenString()}&probe=${probeSentinel}`,
        { post: { body: 'credlog post' }, meta: { feeds: luna.username } },
      );
      expect(resp, 'to satisfy', { __httpCode: 200 });

      const rows = await dbAdapter.database('app_tokens_log').where('token_id', token.id);
      expect(rows.length, 'to be greater than', 0);

      for (const row of rows) {
        expect(row.request, 'to be', 'POST /v1/posts');
        expect(JSON.stringify(row), 'not to contain', probeSentinel);
        expect(JSON.stringify(row), 'not to contain', token.tokenString());
      }
    });
  });
});
