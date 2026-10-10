import createDebug from 'debug';

import { dbAdapter, Job, JobManager } from '../models';
import { UserMailer } from '../mailers';
import { currentConfig } from '../support/app-async-context';

export const PASSWORD_RESET_EMAIL = 'PASSWORD_RESET_EMAIL';

const debug = createDebug('freefeed:jobs:password-reset');

export async function enqueuePasswordReset(email: string): Promise<void> {
  await Job.create(PASSWORD_RESET_EMAIL, { email });
}

export function initHandlers(jobManager: JobManager) {
  jobManager.on(PASSWORD_RESET_EMAIL, async (job: Job<{ email: string }>) => {
    if (job.attempts > 1 || Date.now() - job.createdAt.getTime() > 3_600_000) {
      return;
    }

    try {
      const { email } = job.payload;
      const users = currentConfig().emailVerification.enabled
        ? await dbAdapter.getUsersByNormEmail(email)
        : [await dbAdapter.getUserByEmail(email)];

      for (const user of users) {
        if (!user || (!user.isActive && !user.isResumable)) {
          continue;
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          await user.updateResetPasswordToken();
          // eslint-disable-next-line no-await-in-loop
          await UserMailer.resetPassword(user, { user });
        } catch {
          debug('password-reset-recipient-failed job=%s user=%s', job.id, user.id);
        }
      }
    } catch {
      debug('password-reset-job-failed job=%s', job.id);
    }
  });
}
