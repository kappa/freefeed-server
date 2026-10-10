import { dbAdapter } from '../../../models';
import { UserMailer } from '../../../mailers';
import { NotFoundException } from '../../../support/exceptions';
import { admitResetCompletion, admitResetRequest } from '../../../support/password-reset-limits';
import { enqueuePasswordReset } from '../../../jobs/password-reset';

const GENERIC_RESET_MESSAGE =
  'If an eligible account exists for that address, password reset instructions will be sent.';

/** @param {import('../../../support/types').Ctx} ctx */
function tooManyResetRequests(ctx, retryAfterSeconds) {
  ctx.set('Retry-After', String(retryAfterSeconds));
  ctx.status = 429;
  ctx.body = { err: 'Too many password reset requests. Please try again later.' };
}

/** @param {import('../../../support/types').Ctx} ctx */
function resetServiceUnavailable(ctx) {
  ctx.status = 503;
  ctx.body = { err: 'Password reset is temporarily unavailable. Please try again later.' };
}

export default class PasswordsController {
  /** @param {import('../../../support/types').Ctx} ctx */
  static async create(ctx) {
    const { email } = ctx.request.body;

    if (typeof email !== 'string' || email.trim().length === 0) {
      ctx.status = 400;
      ctx.body = { err: 'Email cannot be blank' };
      return;
    }

    if (email.trim().length > 254) {
      ctx.status = 400;
      ctx.body = { err: 'Email is too long' };
      return;
    }

    let admission;

    try {
      admission = await admitResetRequest(email.trim(), ctx.ip);
    } catch {
      resetServiceUnavailable(ctx);
      return;
    }

    if (!admission.allowed) {
      if (admission.scope === 'email') {
        ctx.set('Cache-Control', 'no-store');
        ctx.status = 200;
        ctx.body = { message: GENERIC_RESET_MESSAGE };
        return;
      }

      tooManyResetRequests(ctx, admission.retryAfterSeconds);
      return;
    }

    if (ctx.config.passwordReset.asyncEmail) {
      try {
        await enqueuePasswordReset(email.trim());
      } catch {
        resetServiceUnavailable(ctx);
        return;
      }

      ctx.set('Cache-Control', 'no-store');
      ctx.body = { message: GENERIC_RESET_MESSAGE };
      return;
    }

    let users;

    if (ctx.config.emailVerification.enabled) {
      users = await dbAdapter.getUsersByNormEmail(email);
    } else {
      users = [await dbAdapter.getUserByEmail(email)];
    }

    users = users.filter((u) => u?.isActive || u?.isResumable);

    ctx.set('Cache-Control', 'no-store');

    if (users.length === 0) {
      ctx.status = 200;
      ctx.body = { message: GENERIC_RESET_MESSAGE };
      return;
    }

    await Promise.all(
      users.map(async (user) => {
        await user.updateResetPasswordToken();
        await UserMailer.resetPassword(user, { user });
      }),
    );

    ctx.body = { message: GENERIC_RESET_MESSAGE };
  }

  static async update(ctx) {
    const token = ctx.params.resetPasswordToken;

    if (token == null || token.length == 0) {
      ctx.status = 400;
      ctx.body = { err: 'Token cannot be blank' };
      return;
    }

    let admission;

    try {
      admission = await admitResetCompletion(ctx.ip);
    } catch {
      resetServiceUnavailable(ctx);
      return;
    }

    if (!admission.allowed) {
      tooManyResetRequests(ctx, admission.retryAfterSeconds);
      return;
    }

    const user = await dbAdapter.getUserByResetToken(token);

    if (!user?.isActive && !user?.isResumable) {
      throw new NotFoundException(`Password reset token not found or has expired`);
    }

    await user.updatePassword(ctx.request.body.newPassword, ctx.request.body.passwordConfirmation);
    await user.updateResetPasswordToken();

    ctx.body = { message: 'Your new password has been saved' };
  }
}
