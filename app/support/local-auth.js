import bcrypt from 'bcrypt';
import config from 'config';
import createDebug from 'debug';

import { dbAdapter } from '../models';

import { currentConfig } from './app-async-context';

const debug = createDebug('freefeed:local-auth');

const INVALID_CREDENTIALS_MESSAGE = 'Invalid username or password.';

let dummyHashPromise = null;

function getDummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(
      'dummy-password-for-unknown-account',
      config.performance.bcryptRounds,
    );
  }

  return dummyHashPromise;
}

export async function authenticateUser(username, clearPassword) {
  const genericFailure = () => ({ error: { message: INVALID_CREDENTIALS_MESSAGE } });

  try {
    let user;

    if (username.includes('@')) {
      user = await dbAdapter.getUserByEmail(username.trim());
    } else {
      user = await dbAdapter.getUserByUsername(username.trim());
    }

    if (!user || (!user.isActive && !user.isResumable)) {
      // Unknown or permanently ineligible account: still run one password
      // comparison against a process-level dummy hash so that the response
      // does not reveal whether the account exists.
      await bcrypt.compare(clearPassword, await getDummyHash());
      return genericFailure();
    }

    const validPwd = await user.validPassword(clearPassword);

    if (!validPwd) {
      return genericFailure();
    }

    if (await user.isFrozen()) {
      const { adminEmail } = currentConfig();
      return {
        error: {
          message:
            'Your account has been suspended due to suspicious activity. ' +
            `Please contact support${adminEmail ? ` at ${adminEmail}` : ''} if you believe this is an error.`,
        },
      };
    }

    if (user.isResumable) {
      return {
        error: {
          message: 'Your account is now inactive but you can resume it.',
          userId: user.id,
          isResumable: true,
        },
      };
    }

    return { user };
  } catch (err) {
    debug('authentication failure', err);
    return genericFailure();
  }
}
