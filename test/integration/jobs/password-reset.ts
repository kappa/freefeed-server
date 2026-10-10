import { after, before, beforeEach, describe, it } from 'mocha';
import expect from 'unexpected';
import { merge } from 'lodash-es';
import createDebug from 'debug';

import cleanDB from '../../dbCleaner';
import { dbAdapter, Job, JobManager, User } from '../../../app/models';
import { GONE_COOLDOWN, GONE_DELETED, GONE_PAUSED, GONE_SUSPENDED } from '../../../app/models/user';
import {
  PASSWORD_RESET_EMAIL,
  enqueuePasswordReset,
  initHandlers,
} from '../../../app/jobs/password-reset';
import PasswordsController from '../../../app/controllers/api/v1/PasswordsController';
import { type Ctx } from '../../../app/support/types';
import { currentConfig } from '../../../app/support/app-async-context';
import { UserMailer } from '../../../app/mailers';
import { addMailListener } from '../../../lib/mailer';
import { withModifiedConfig } from '../../helpers/with-modified-config';

const GENERIC_MESSAGE =
  'If an eligible account exists for that address, password reset instructions will be sent.';
const SERVICE_UNAVAILABLE = 'Password reset is temporarily unavailable. Please try again later.';
const SECRET_TOKEN = 'reset-token-SECRET-9f8e7d6c5b4a';

type CapturedMail = { envelope: { to: string[] } };

async function createUserWithEmail(username: string, email: string): Promise<User> {
  const user = new User({ username, password: 'pw', email });
  await user.create();
  return user;
}

// The User constructor blanks tokens of inactive users, so read the row directly
const tokenOf = async (userId: string) =>
  await dbAdapter.database.getOne<string | null>(
    'select reset_password_token from users where uid = ?',
    userId,
  );

async function withCapturedDiagnostics<T>(run: () => Promise<T>) {
  const lines: string[] = [];
  const originalLog = createDebug.log;
  createDebug.log = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };

  createDebug.enable('freefeed:jobs:password-reset');

  try {
    const result = await run();
    return { result, lines };
  } finally {
    createDebug.disable();
    createDebug.log = originalLog;
  }
}

// Sinon ships without TypeScript declarations here, so tests swap methods
// directly and restore them. Returns the restore function.
function replaceMethod<T extends object, K extends keyof T>(obj: T, key: K, replacement: T[K]) {
  const original = obj[key];
  obj[key] = replacement;

  return () => {
    obj[key] = original;
  };
}

describe('Password reset emails', () => {
  let jm: JobManager;
  const capturedMail: CapturedMail[] = [];
  let removeMailListener: () => void = () => undefined;

  before(() => {
    jm = new JobManager();
    initHandlers(jm);
    removeMailListener = addMailListener((mail: CapturedMail) => {
      capturedMail.push(mail);
    });
  });

  after(() => removeMailListener());

  beforeEach(async () => {
    await cleanDB(dbAdapter.database);
    capturedMail.length = 0;
  });

  it('should send reset mail and rotate token for an active user', async () => {
    const email = 'luna@example.com';
    const user = await createUserWithEmail('luna', email);
    const tokenBefore = await tokenOf(user.id);

    await enqueuePasswordReset(email);

    const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
    expect(queued, 'to have length', 1);
    expect(queued[0].payload, 'to equal', { email });

    const [processed] = await jm.fetchAndProcess(10);
    expect(processed.attempts, 'to be', 1);

    expect(capturedMail, 'to have length', 1);
    expect(capturedMail[0], 'to satisfy', { envelope: { to: [email] } });
    expect(await tokenOf(user.id), 'to be a string');
    expect(await tokenOf(user.id), 'not to be', tokenBefore);
    expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');
  });

  it('should send reset mail to resumable users', async () => {
    const paused = await createUserWithEmail('paused', 'paused@example.com');
    await paused.setGoneStatus(GONE_PAUSED);
    const cooldown = await createUserWithEmail('cooldown', 'cooldown@example.com');
    await cooldown.setGoneStatus(GONE_COOLDOWN);

    await enqueuePasswordReset('paused@example.com');
    await enqueuePasswordReset('cooldown@example.com');
    await jm.fetchAndProcess(10);

    expect(capturedMail, 'to have length', 2);
    const recipients = capturedMail.map((mail) => mail.envelope.to[0]).sort();
    expect(recipients, 'to equal', ['cooldown@example.com', 'paused@example.com']);
    expect(await tokenOf(paused.id), 'to be a string');
    expect(await tokenOf(cooldown.id), 'to be a string');
  });

  it('should not mail suspended or deleted users', async () => {
    const suspended = await createUserWithEmail('suspended', 'suspended@example.com');
    await suspended.setGoneStatus(GONE_SUSPENDED);
    const deleted = await createUserWithEmail('deleted', 'deleted@example.com');
    await deleted.setGoneStatus(GONE_DELETED);
    const suspendedToken = await tokenOf(suspended.id);
    const deletedToken = await tokenOf(deleted.id);

    await enqueuePasswordReset('suspended@example.com');
    await enqueuePasswordReset('deleted@example.com');
    await jm.fetchAndProcess(10);

    expect(capturedMail, 'to be empty');
    expect(await tokenOf(suspended.id), 'to be', suspendedToken);
    expect(await tokenOf(deleted.id), 'to be', deletedToken);
    expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');
  });

  it('should not mail unknown addresses', async () => {
    await enqueuePasswordReset('absent@example.test');
    await jm.fetchAndProcess(10);

    expect(capturedMail, 'to be empty');
    expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');
  });

  describe('with email verification enabled', () => {
    withModifiedConfig({ emailVerification: { enabled: true } });

    it('should send one mail per eligible account sharing a normalized address', async () => {
      await createUserWithEmail('luna', 'luna@example.com');
      await createUserWithEmail('luna2', 'luna+2@example.com');
      const suspended = await createUserWithEmail('suspended', 'luna+9@example.com');
      await suspended.setGoneStatus(GONE_SUSPENDED);

      await enqueuePasswordReset('luna+3@example.com');
      await jm.fetchAndProcess(10);

      expect(capturedMail, 'to have length', 2);
      const recipients = capturedMail.map((mail) => mail.envelope.to[0]).sort();
      expect(recipients, 'to equal', ['luna+2@example.com', 'luna@example.com']);
    });

    it('should isolate per-recipient failures and keep diagnostics free of secrets', async () => {
      const luna = await createUserWithEmail('luna', 'luna@example.com');
      await createUserWithEmail('luna2', 'luna+2@example.com');

      const sendResetPassword = UserMailer.resetPassword.bind(UserMailer);
      const restoreMailer = replaceMethod(UserMailer, 'resetPassword', async (user: User) => {
        if (user.id === luna.id) {
          throw new Error(SECRET_TOKEN);
        }

        await sendResetPassword(user, { user });
      });

      try {
        await enqueuePasswordReset('luna+3@example.com');

        const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
        expect(queued, 'to have length', 1);

        const { lines } = await withCapturedDiagnostics(() => jm.fetchAndProcess(10));

        expect(capturedMail, 'to have length', 1);
        expect(capturedMail[0], 'to satisfy', { envelope: { to: ['luna+2@example.com'] } });
        expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');

        const diagnostics = lines.filter((line) => line.includes('password-reset-'));
        expect(diagnostics.length, 'to be greater than', 0);
        expect(
          diagnostics.some((line) => line.includes('password-reset-recipient-failed')),
          'to be',
          true,
        );
        expect(
          diagnostics.some((line) => line.includes(queued[0].id) && line.includes(luna.id)),
          'to be',
          true,
        );

        for (const line of lines) {
          expect(line, 'not to contain', SECRET_TOKEN);
        }
      } finally {
        restoreMailer();
      }
    });
  });

  describe('with email verification disabled', () => {
    withModifiedConfig({ emailVerification: { enabled: false } });

    it('should match exact addresses only', async () => {
      await createUserWithEmail('luna', 'luna@example.com');
      await createUserWithEmail('luna2', 'luna+2@example.com');

      await enqueuePasswordReset('luna+3@example.com');
      await jm.fetchAndProcess(10);
      expect(capturedMail, 'to be empty');

      await enqueuePasswordReset('luna@example.com');
      await jm.fetchAndProcess(10);
      expect(capturedMail, 'to have length', 1);
      expect(capturedMail[0], 'to satisfy', { envelope: { to: ['luna@example.com'] } });
    });
  });

  it('should ignore stale jobs without looking up users', async () => {
    const email = 'luna@example.com';
    const user = await createUserWithEmail('luna', email);
    const tokenBefore = await tokenOf(user.id);

    await enqueuePasswordReset(email);

    const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
    expect(queued, 'to have length', 1);
    await dbAdapter.database.raw(
      `update jobs set created_at = now() - interval '2 hours' where id = ?`,
      queued[0].id,
    );

    let lookupCalls = 0;
    const failLookup = () => {
      lookupCalls += 1;
      return Promise.reject(new Error('must not look up'));
    };
    const restoreByEmail = replaceMethod(dbAdapter, 'getUserByEmail', failLookup);
    const restoreByNormEmail = replaceMethod(dbAdapter, 'getUsersByNormEmail', failLookup);

    try {
      await jm.fetchAndProcess(10);
    } finally {
      restoreByEmail();
      restoreByNormEmail();
    }

    expect(lookupCalls, 'to be', 0);
    expect(capturedMail, 'to be empty');
    expect(await tokenOf(user.id), 'to be', tokenBefore);
    expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');
  });

  it('should ignore redelivered jobs without looking up users', async () => {
    const email = 'luna@example.com';
    const user = await createUserWithEmail('luna', email);
    const tokenBefore = await tokenOf(user.id);

    await enqueuePasswordReset(email);

    const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
    expect(queued, 'to have length', 1);
    await dbAdapter.database.raw(`update jobs set attempts = 2 where id = ?`, queued[0].id);

    let lookupCalls = 0;
    const failLookup = () => {
      lookupCalls += 1;
      return Promise.reject(new Error('must not look up'));
    };
    const restoreByEmail = replaceMethod(dbAdapter, 'getUserByEmail', failLookup);
    const restoreByNormEmail = replaceMethod(dbAdapter, 'getUsersByNormEmail', failLookup);

    try {
      await jm.fetchAndProcess(10);
    } finally {
      restoreByEmail();
      restoreByNormEmail();
    }

    expect(lookupCalls, 'to be', 0);
    expect(capturedMail, 'to be empty');
    expect(await tokenOf(user.id), 'to be', tokenBefore);
    expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');
  });

  it('should apply eligibility at processing time', async () => {
    const suspended = await createUserWithEmail('suspended', 'suspended@example.com');
    const deleted = await createUserWithEmail('deleted', 'deleted@example.com');
    await enqueuePasswordReset('suspended@example.com');
    await enqueuePasswordReset('deleted@example.com');

    await suspended.setGoneStatus(GONE_SUSPENDED);
    await deleted.setGoneStatus(GONE_DELETED);
    const suspendedToken = await tokenOf(suspended.id);
    const deletedToken = await tokenOf(deleted.id);

    await jm.fetchAndProcess(10);

    expect(capturedMail, 'to be empty');
    expect(await tokenOf(suspended.id), 'to be', suspendedToken);
    expect(await tokenOf(deleted.id), 'to be', deletedToken);
  });

  it('should mail accounts created after the request was queued', async () => {
    const email = 'luna@example.com';
    await enqueuePasswordReset(email);

    const user = await createUserWithEmail('luna', email);
    await jm.fetchAndProcess(10);

    expect(capturedMail, 'to have length', 1);
    expect(capturedMail[0], 'to satisfy', { envelope: { to: [email] } });
    expect(await tokenOf(user.id), 'to be a string');
  });

  it('should consume lookup failures and keep diagnostics free of secrets', async () => {
    const email = 'luna@example.com';
    await createUserWithEmail('luna', email);

    const failLookup = () => Promise.reject(new Error(SECRET_TOKEN));
    const restoreByEmail = replaceMethod(dbAdapter, 'getUserByEmail', failLookup);
    const restoreByNormEmail = replaceMethod(dbAdapter, 'getUsersByNormEmail', failLookup);

    try {
      await enqueuePasswordReset(email);

      const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
      expect(queued, 'to have length', 1);

      const { lines } = await withCapturedDiagnostics(() => jm.fetchAndProcess(10));

      expect(capturedMail, 'to be empty');
      expect(await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]), 'to be empty');

      const diagnostics = lines.filter((line) => line.includes('password-reset-'));
      expect(diagnostics.length, 'to be greater than', 0);
      expect(
        diagnostics.some((line) => line.includes('password-reset-job-failed')),
        'to be',
        true,
      );
      expect(
        diagnostics.some((line) => line.includes(queued[0].id)),
        'to be',
        true,
      );

      for (const line of lines) {
        expect(line, 'not to contain', SECRET_TOKEN);
      }
    } finally {
      restoreByEmail();
      restoreByNormEmail();
    }
  });

  describe('recovery initiation', () => {
    const makeCtx = (email: string) => {
      const headers: Record<string, string> = {};
      const ctx = {
        request: { body: { email } },
        ip: '192.0.2.5',
        config: merge({}, currentConfig(), { passwordReset: { asyncEmail: true } }),
        set: (name: string, value: string) => {
          headers[name] = value;
        },
        // Koa answers 200 once a body is set; error paths assign status explicitly
        status: 200,
        body: undefined as unknown,
      };
      return { ctx, headers };
    };

    it('should return generic 503 without lookup when queue insertion fails', async () => {
      const failCreate = () => Promise.reject(new Error('queue down'));
      const restoreCreate = replaceMethod(Job, 'create', failCreate);

      let lookupCalls = 0;
      const failLookup = () => {
        lookupCalls += 1;
        return Promise.reject(new Error('must not look up'));
      };
      const restoreByEmail = replaceMethod(dbAdapter, 'getUserByEmail', failLookup);
      const restoreByNormEmail = replaceMethod(dbAdapter, 'getUsersByNormEmail', failLookup);

      try {
        for (const email of ['luna@example.com', 'absent@example.test']) {
          const { ctx } = makeCtx(email);
          // eslint-disable-next-line no-await-in-loop
          await PasswordsController.create(ctx as unknown as Ctx);
          expect(ctx.status, 'to be', 503);
          expect(ctx.body, 'to equal', { err: SERVICE_UNAVAILABLE });
        }

        expect(lookupCalls, 'to be', 0);
        expect(capturedMail, 'to be empty');
      } finally {
        restoreCreate();
        restoreByEmail();
        restoreByNormEmail();
      }
    });

    it('should queue the request without lookup or mail on the initiation path', async () => {
      let lookupCalls = 0;
      const failLookup = () => {
        lookupCalls += 1;
        return Promise.reject(new Error('must not look up'));
      };
      const restoreByEmail = replaceMethod(dbAdapter, 'getUserByEmail', failLookup);
      const restoreByNormEmail = replaceMethod(dbAdapter, 'getUsersByNormEmail', failLookup);

      try {
        for (const email of ['luna@example.com', 'absent@example.test']) {
          const { ctx, headers } = makeCtx(email);
          // eslint-disable-next-line no-await-in-loop
          await PasswordsController.create(ctx as unknown as Ctx);
          expect(ctx.status, 'to be', 200);
          expect(ctx.body, 'to equal', { message: GENERIC_MESSAGE });
          expect(headers, 'to satisfy', { 'Cache-Control': 'no-store' });
        }

        expect(lookupCalls, 'to be', 0);
        expect(capturedMail, 'to be empty');

        const queued = await dbAdapter.getAllJobs([PASSWORD_RESET_EMAIL]);
        expect(queued, 'to have length', 2);
        const payloads = queued
          .map((job) => job.payload as { email: string })
          .sort((a, b) => (a.email < b.email ? -1 : 1));
        expect(payloads, 'to equal', [
          { email: 'absent@example.test' },
          { email: 'luna@example.com' },
        ]);
      } finally {
        restoreByEmail();
        restoreByNormEmail();
      }
    });
  });
});
