/* global $pg_database */
import expect from 'unexpected';

import cleanDB from '../dbCleaner';
import { getSingleton } from '../../app/app';
import { DummyPublisher } from '../../app/pubsub';
import { dbAdapter, JobManager, PubSub } from '../../app/models';
import database from '../../app/setup/database';
import { passwordResetKeys } from '../../app/support/password-reset-limits';
import { initHandlers as initPasswordResetHandlers } from '../../app/jobs/password-reset';

import {
  createUserAsync,
  performJSONRequest,
  performRequest,
  withEmailCapture,
  withModifiedAppConfig,
} from './functional_test_helper';

const GENERIC_MESSAGE =
  'If an eligible account exists for that address, password reset instructions will be sent.';

// Functional tests reach the app over loopback; the observed peer address can be
// IPv4 or IPv6 depending on host resolution, so bucket cleanup covers both forms.
const LOOPBACK_IPS = ['127.0.0.1', '::1'];

const EMAILS = {
  cooldown: 'reset-cooldown@example.test',
  authHeader: 'reset-auth-header@example.test',
  unknown: 'reset-unknown@example.test',
};

const ipFloodEmails = (n) => Array.from({ length: n }, (_, i) => `reset-ip-${i}@example.test`);
const forgedHeaderEmails = (n) =>
  Array.from({ length: n }, (_, i) => `reset-forged-${i}@example.test`);

const ALL_FIXTURE_EMAILS = [
  ...Object.values(EMAILS),
  ...ipFloodEmails(6),
  ...forgedHeaderEmails(6),
];

async function clearResetBuckets() {
  const keys = new Set();

  for (const ip of LOOPBACK_IPS) {
    for (const email of ALL_FIXTURE_EMAILS) {
      const k = passwordResetKeys(email, ip);
      keys.add(k.ipAttempts);
      keys.add(k.completionAttempts);
      keys.add(k.emailAdmitted);
      keys.add(k.emailCooldown);
    }
  }

  if (keys.size > 0) {
    await database.del(...keys);
  }
}

describe('Password reset limits', () => {
  before(async () => {
    await getSingleton();
    PubSub.setPublisher(new DummyPublisher());
  });

  withModifiedAppConfig({
    passwordReset: {
      rateLimit: {
        enabled: true,
        perIP: { count: 5, intervalSec: 3600 },
        perEmail: { count: 2, intervalSec: 3600 },
        emailCooldownSec: 60,
        completionPerIP: { count: 5, intervalSec: 900 },
      },
    },
  });

  const emails = withEmailCapture({ multiple: true });

  beforeEach(async () => {
    await cleanDB($pg_database);
    await clearResetBuckets();
  });

  afterEach(async () => {
    await clearResetBuckets();
  });

  it('should suppress repeated initiation within the email cooldown without mail or token rotation', async () => {
    const email = EMAILS.cooldown;
    await createUserAsync('Luna', 'password', { email });

    const tokenOf = async () => (await dbAdapter.getUserByEmail(email)).resetPasswordToken;

    const first = await performJSONRequest('POST', '/v1/passwords', { email });
    expect(first, 'to satisfy', { __httpCode: 200 });
    await processPasswordResetJobs();
    expect(emails.current, 'to have length', 1);
    const admittedToken = await tokenOf();
    expect(admittedToken, 'to be a string');

    const second = await performJSONRequest('POST', '/v1/passwords', { email });
    expect(second, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
    expect(emails.current, 'to have length', 1);
    expect(await tokenOf(), 'to be', admittedToken);
  });

  it('should return 429 with Retry-After when the IP initiation limit is exceeded', async () => {
    const flood = ipFloodEmails(6);

    for (const email of flood.slice(0, 5)) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await performJSONRequest('POST', '/v1/passwords', { email });
      expect(resp, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
    }

    const resp = await performRequest('/v1/passwords', {
      method: 'POST',
      body: JSON.stringify({ email: flood[5] }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status, 'to be', 429);
    expect(resp.headers.get('Retry-After'), 'to match', /^[1-9]\d*$/);
    const body = await resp.json();
    expect(body, 'to satisfy', {
      err: 'Too many password reset requests. Please try again later.',
    });
  });

  it('should count forged proxy headers against the same peer bucket', async () => {
    const flood = forgedHeaderEmails(6);
    const forged = [
      { 'X-Forwarded-For': '203.0.113.7' },
      { 'X-Real-IP': '198.51.100.9' },
      { 'X-Forwarded-For': '192.0.2.1, 203.0.113.7', 'X-Real-IP': '192.0.2.1' },
      { 'X-Forwarded-For': 'not-an-ip' },
      { 'X-Real-IP': '2001:db8::1' },
      { 'X-Forwarded-For': '203.0.113.8' },
    ];

    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await performJSONRequest(
        'POST',
        '/v1/passwords',
        { email: flood[i] },
        forged[i],
      );
      expect(resp, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
    }

    const resp = await performJSONRequest('POST', '/v1/passwords', { email: flood[5] }, forged[5]);
    expect(resp, 'to satisfy', {
      __httpCode: 429,
      err: 'Too many password reset requests. Please try again later.',
    });
  });

  it('should still recover with an invalid Authorization header', async () => {
    const email = EMAILS.authHeader;
    await createUserAsync('Luna', 'password', { email });

    const resp = await performJSONRequest(
      'POST',
      '/v1/passwords',
      { email },
      { Authorization: 'Bearer invalid' },
    );
    expect(resp, 'to satisfy', { __httpCode: 200 });
    await processPasswordResetJobs();
    expect(emails.current, 'to have length', 1);
  });

  it('should return 429 when the IP completion limit is exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await performJSONRequest('PUT', '/v1/passwords/no-such-token');
      expect(resp, 'to satisfy', {
        __httpCode: 404,
        err: 'Password reset token not found or has expired',
      });
    }

    const resp = await performRequest('/v1/passwords/no-such-token', {
      method: 'PUT',
      body: JSON.stringify({ newPassword: 'x', passwordConfirmation: 'x' }),
      headers: { 'Content-Type': 'application/json' },
    });
    expect(resp.status, 'to be', 429);
    expect(resp.headers.get('Retry-After'), 'to match', /^[1-9]\d*$/);
  });

  it('should suppress repeated initiation for unknown addresses with the generic message', async () => {
    const email = EMAILS.unknown;

    const first = await performJSONRequest('POST', '/v1/passwords', { email });
    expect(first, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
    await processPasswordResetJobs();

    const second = await performJSONRequest('POST', '/v1/passwords', { email });
    expect(second, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
    expect(emails.current, 'to have length', 0);
  });

  it('should reject blank, non-string and overlong emails with 400', async () => {
    for (const email of ['', '   ', 123, null]) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await performJSONRequest('POST', '/v1/passwords', { email });
      expect(resp, 'to satisfy', { __httpCode: 400, err: 'Email cannot be blank' });
    }

    const overlong = `${'x'.repeat(250)}@example.test`;
    expect(overlong.length, 'to be greater than', 254);
    const resp = await performJSONRequest('POST', '/v1/passwords', { email: overlong });
    expect(resp, 'to satisfy', { __httpCode: 400 });
  });
});

async function processPasswordResetJobs(count = 10) {
  const jobManager = new JobManager();
  initPasswordResetHandlers(jobManager);
  await jobManager.fetchAndProcess(count);
}
