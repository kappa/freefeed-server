import { format } from 'util';

import { beforeEach, describe, it } from 'mocha';
import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { User, dbAdapter } from '../../../../app/models';

// Members that exist at runtime but are absent from the User type
type UserSecrets = {
  updateResetPasswordToken(): Promise<string>;
  hashedPassword: string;
};

type TimelineName = Parameters<User['getGenericTimelineId']>[0];

describe('User missing-timeline diagnostics', () => {
  beforeEach(() => cleanDB(dbAdapter.database));

  it('should log only the user ID and timeline name, never user secrets', async () => {
    const markerEmail = 'safe08marker@example.com';
    const user = new User({ username: 'luna', password: 'pw', email: markerEmail });
    await user.create();
    const withSecrets = user as unknown as UserSecrets;
    const markerToken = await withSecrets.updateResetPasswordToken();
    const markerHash = withSecrets.hashedPassword;
    // The runtime accepts any feed name; the unknown one takes the not-found path
    const missingName = String('NoSuchTimeline08');

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(format(...args));
    };

    try {
      const result = await user.getGenericTimelineId(missingName as TimelineName);
      expect(result, 'to be', null);
    } finally {
      console.log = originalLog;
    }

    const output = logged.join('\n');
    expect(output, 'to contain', 'NoSuchTimeline08');
    expect(output, 'to contain', user.id);
    expect(output, 'not to contain', markerEmail);
    expect(output, 'not to contain', markerHash);
    expect(output, 'not to contain', markerToken);
    expect(output, 'not to contain', 'hashedPassword');
    expect(output, 'not to contain', 'resetPasswordToken');
  });
});
