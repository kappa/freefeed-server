import expect from 'unexpected';

import { validateExternalAuthProviders } from '../../app/support/ExtAuth/validate-providers';

describe('validateExternalAuthProviders', () => {
  const testProvider = { id: 'test', adapter: 'test' };
  const oauthProvider = { id: 'google', adapter: 'oauth2' };

  describe('outside the test environment', () => {
    const envs = ['production', 'development', 'TEST', undefined];

    for (const env of envs) {
      it(`should reject the test adapter when NODE_ENV is ${JSON.stringify(env)}`, () => {
        expect(
          () => validateExternalAuthProviders([testProvider], env),
          'to throw',
          `Test authentication provider 'test' is disabled outside tests`,
        );
      });
    }

    it('should reject a test adapter resolved through a template', () => {
      // After template resolution the entry carries the merged id and adapter
      const resolved = { id: 'custom-test', adapter: 'test' };

      expect(
        () => validateExternalAuthProviders([oauthProvider, resolved], 'production'),
        'to throw',
        `Test authentication provider 'custom-test' is disabled outside tests`,
      );
    });

    it('should not leak provider secrets into the error', () => {
      const provider = {
        id: 'test',
        adapter: 'test',
        params: { clientSecret: 'super-secret-value' },
      } as { id: string; adapter: string };

      let message = '';

      try {
        validateExternalAuthProviders([provider], 'production');
      } catch (err) {
        ({ message } = err as Error);
      }

      expect(message, 'to be', `Test authentication provider 'test' is disabled outside tests`);
      expect(message, 'not to contain', 'super-secret-value');
    });

    it('should allow OAuth-only providers', () => {
      expect(() => validateExternalAuthProviders([oauthProvider], 'production'), 'not to throw');
    });

    it('should allow an empty provider list', () => {
      expect(() => validateExternalAuthProviders([], 'production'), 'not to throw');
    });
  });

  describe('in the test environment', () => {
    it('should allow the test adapter when NODE_ENV is exactly test', () => {
      expect(
        () => validateExternalAuthProviders([oauthProvider, testProvider], 'test'),
        'not to throw',
      );
    });
  });
});
