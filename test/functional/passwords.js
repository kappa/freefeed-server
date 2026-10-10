/* global $pg_database */
import expect from 'unexpected';
import { simpleParser } from 'mailparser';
import config from 'config';

import cleanDB from '../dbCleaner';
import { getSingleton } from '../../app/app';
import { DummyPublisher } from '../../app/pubsub';
import { dbAdapter, JobManager, PubSub } from '../../app/models';
import { GONE_PAUSED, GONE_SUSPENDED } from '../../app/models/user';
import {
  PASSWORD_RESET_EMAIL,
  initHandlers as initPasswordResetHandlers,
} from '../../app/jobs/password-reset';
import { addMailListener } from '../../lib/mailer';

import {
  createUserAsync,
  performJSONRequest,
  performRequest,
  updateUserAsync,
  withEmailCapture,
  withModifiedAppConfig,
} from './functional_test_helper';

describe('PasswordsController', () => {
  before(async () => {
    await getSingleton();
    PubSub.setPublisher(new DummyPublisher());
  });

  describe('#create()', () => {
    let luna;
    const oldEmail = 'test@example.com';

    beforeEach(async () => {
      await cleanDB($pg_database);
      luna = await createUserAsync('Luna', 'password', { email: oldEmail });
    });

    it('should require email', async () => {
      const resp = await performJSONRequest('POST', '/v1/passwords', { email: '' });
      expect(resp, 'to satisfy', { __httpCode: 400, err: 'Email cannot be blank' });
    });

    it('should generate resetToken by original email of user', async () => {
      const resp = await performJSONRequest('POST', '/v1/passwords', { email: oldEmail });
      expect(resp, 'to satisfy', {
        __httpCode: 200,
        message:
          'If an eligible account exists for that address, password reset instructions will be sent.',
      });
    });

    it('should generate resetToken by new email of user', async () => {
      const email = 'luna@example.com';

      await updateUserAsync(luna, { email });

      {
        const resp = await performJSONRequest('POST', '/v1/passwords', { email: oldEmail });
        expect(resp, 'to satisfy', {
          __httpCode: 200,
          message:
            'If an eligible account exists for that address, password reset instructions will be sent.',
        });
      }

      {
        const resp = await performJSONRequest('POST', '/v1/passwords', { email });
        expect(resp, 'to satisfy', {
          __httpCode: 200,
          message:
            'If an eligible account exists for that address, password reset instructions will be sent.',
        });
      }
    });

    it('should generate resetToken by email with capital letters', async () => {
      const email = 'Luna@example.com';

      await updateUserAsync(luna, { email });

      const resp = await performJSONRequest('POST', '/v1/passwords', { email });
      expect(resp, 'to satisfy', {
        __httpCode: 200,
        message:
          'If an eligible account exists for that address, password reset instructions will be sent.',
      });
    });
  });

  describe('Uniform recovery initiation', () => {
    const knownEmail = 'luna@example.com';
    const absentEmail = 'absent@example.test';
    const suspendedEmail = 'suspended@example.test';
    const pausedEmail = 'paused@example.test';
    const GENERIC_MESSAGE =
      'If an eligible account exists for that address, password reset instructions will be sent.';

    const emails = withEmailCapture({ multiple: true });

    beforeEach(async () => {
      await cleanDB($pg_database);
      await createUserAsync('Luna', 'password', { email: knownEmail });
      const suspended = await createUserAsync('Suspended', 'password', { email: suspendedEmail });
      await setGoneStatus(suspended, GONE_SUSPENDED);
      const paused = await createUserAsync('Paused', 'password', { email: pausedEmail });
      await setGoneStatus(paused, GONE_PAUSED);
    });

    for (const asyncEmail of [false, true]) {
      describe(`asyncEmail=${asyncEmail}`, () => {
        withModifiedAppConfig({ passwordReset: { asyncEmail } });

        it('should return identical responses for eligible, unknown, suspended and paused accounts', async () => {
          const bodies = await Promise.all(
            [knownEmail, absentEmail, suspendedEmail, pausedEmail].map((email) =>
              performJSONRequest('POST', '/v1/passwords', { email }),
            ),
          );

          for (const body of bodies.slice(1)) {
            expect(body, 'to equal', bodies[0]);
          }

          expect(bodies[0], 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
        });

        it('should mark recovery responses as not storable', async () => {
          for (const email of [knownEmail, absentEmail]) {
            // eslint-disable-next-line no-await-in-loop
            const resp = await performRequest('/v1/passwords', {
              method: 'POST',
              body: JSON.stringify({ email }),
              headers: { 'Content-Type': 'application/json' },
            });
            expect(resp.status, 'to be', 200);
            expect(resp.headers.get('Cache-Control'), 'to be', 'no-store');
          }
        });

        if (asyncEmail) {
          it('should queue a recovery job before any lookup or mail delivery', async () => {
            const tokenBefore = (await dbAdapter.getUserByEmail(knownEmail)).resetPasswordToken;

            const resp = await performJSONRequest('POST', '/v1/passwords', { email: knownEmail });
            expect(resp, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });

            const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
            expect(queued, 'to have length', 1);
            expect(queued[0].payload, 'to equal', { email: knownEmail });
            expect(emails.current, 'to be empty');
            expect(
              (await dbAdapter.getUserByEmail(knownEmail)).resetPasswordToken,
              'to be',
              tokenBefore,
            );

            await processPasswordResetJobs();

            expect(emails.current, 'to have length', 1);
            expect(emails.current[0], 'to satisfy', { envelope: { to: [knownEmail] } });
          });
        } else {
          it('should send recovery mail synchronously in legacy mode', async () => {
            const resp = await performJSONRequest('POST', '/v1/passwords', { email: knownEmail });
            expect(resp, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
            expect(emails.current, 'to have length', 1);
            expect(emails.current[0], 'to satisfy', { envelope: { to: [knownEmail] } });
            expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');

            const absent = await performJSONRequest('POST', '/v1/passwords', {
              email: absentEmail,
            });
            expect(absent, 'to satisfy', { __httpCode: 200, message: GENERIC_MESSAGE });
            expect(emails.current, 'to have length', 1);
          });
        }
      });
    }
  });

  describe('#update()', () => {
    let luna;
    const email = 'luna@example.com';

    beforeEach(async () => {
      await cleanDB($pg_database);

      luna = await createUserAsync('Luna', 'password');
      await updateUserAsync(luna, { email });
      await performJSONRequest('POST', '/v1/passwords', { email });
    });

    it('should not reset password by invalid resetToken', async () => {
      const resp = await performJSONRequest('PUT', '/v1/passwords/token');
      expect(resp, 'to satisfy', {
        __httpCode: 404,
        err: 'Password reset token not found or has expired',
      });
    });
  });

  describe('Password reset sequence', () => {
    withModifiedAppConfig({ passwordReset: { asyncEmail: true } });

    const email = 'luna@example.com';
    const newPassword = 'password1';
    let luna;
    let token;

    let capturedMail = null;
    let removeMailListener = () => null;

    before(async () => {
      await cleanDB($pg_database);
      luna = await createUserAsync('Luna', 'password');
      await updateUserAsync(luna, { email });

      removeMailListener = addMailListener((r) => (capturedMail = r));
    });
    after(removeMailListener);

    it('should send password reset link', async () => {
      const resp = await performJSONRequest('POST', '/v1/passwords', { email });
      expect(resp, 'to satisfy', { __httpCode: 200 });

      await processPasswordResetJobs();

      expect(capturedMail, 'to satisfy', { envelope: { to: [email] } });
      const parsedMail = await simpleParser(capturedMail.response);
      expect(parsedMail, 'to satisfy', { subject: config.mailer.resetPasswordMailSubject });

      const m = /\/reset\?token=(\S+)/.exec(parsedMail.text);
      expect(m, 'not to be null');

      [, token] = m;
    });

    it('should change password using token', async () => {
      const resp = await performJSONRequest('PUT', `/v1/passwords/${token}`, {
        newPassword,
        passwordConfirmation: newPassword,
      });
      expect(resp, 'to satisfy', { __httpCode: 200 });
    });

    it('should allow to log in with the new password', async () => {
      const resp = await performJSONRequest('POST', `/v1/session`, {
        username: luna.username,
        password: newPassword,
      });
      expect(resp, 'to satisfy', { __httpCode: 200 });
    });

    it('should not allow to use same token again', async () => {
      const resp = await performJSONRequest('PUT', `/v1/passwords/${token}`, {
        newPassword,
        passwordConfirmation: newPassword,
      });
      expect(resp, 'to satisfy', { __httpCode: 404 });
    });

    it('should not allow to use expired token', async () => {
      const resp = await performJSONRequest('POST', '/v1/passwords', { email });
      expect(resp, 'to satisfy', { __httpCode: 200 });

      await processPasswordResetJobs();

      const age = parseInt(
        await dbAdapter.database.getOne(
          'select extract(epoch from reset_password_expires_at - reset_password_sent_at) from users where uid = ?',
          luna.user.id,
        ),
      );

      expect(age, 'to be', config.passwordReset.tokenTTL);

      await dbAdapter.database.raw(
        `update users set reset_password_expires_at = now() - interval '1 second' where uid = ?`,
        luna.user.id,
      );

      const resp1 = await performJSONRequest('PUT', `/v1/passwords/${token}`, {
        newPassword,
        passwordConfirmation: newPassword,
      });
      expect(resp1, 'to satisfy', { __httpCode: 404 });
    });
  });
});

async function setGoneStatus(userCtx, status) {
  const user = await dbAdapter.getUserById(userCtx.user.id);
  await user.setGoneStatus(status);
}

async function processPasswordResetJobs(count = 10) {
  const jobManager = new JobManager();
  initPasswordResetHandlers(jobManager);
  await jobManager.fetchAndProcess(count);
}
