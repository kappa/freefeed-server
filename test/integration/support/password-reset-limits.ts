import { afterEach, describe, it } from 'mocha';
import expect from 'unexpected';

import database from '../../../app/setup/database';
import {
  admitResetCompletion,
  admitResetRequest,
  passwordResetKeys,
  type ResetAdmission,
} from '../../../app/support/password-reset-limits';
import { withModifiedConfig } from '../../helpers/with-modified-config';

const LIMITS = {
  enabled: true,
  perIP: { count: 3, intervalSec: 3600 },
  perEmail: { count: 2, intervalSec: 3600 },
  emailCooldownSec: 60,
  completionPerIP: { count: 3, intervalSec: 900 },
};

const allowed = (replies: ResetAdmission[]) => replies.filter((r) => r.allowed);

async function delKeys(pairs: [string, string][]) {
  const keys = new Set<string>();

  for (const [email, ip] of pairs) {
    const k = passwordResetKeys(email, ip);
    keys.add(k.ipAttempts);
    keys.add(k.completionAttempts);
    keys.add(k.emailAdmitted);
    keys.add(k.emailCooldown);
  }

  if (keys.size > 0) {
    await database.del(...keys);
  }
}

describe('Password reset admission', () => {
  withModifiedConfig({ passwordReset: { rateLimit: LIMITS } });

  // Each test uses distinct fixture addresses and removes only its own keys
  const seen: [string, string][] = [];

  const track = (email: string, ip: string): [string, string] => {
    const pair: [string, string] = [email, ip];
    seen.push(pair);
    return pair;
  };

  afterEach(async () => {
    await delKeys(seen.splice(0));
  });

  it('should admit exactly one of many parallel initiation requests', async () => {
    const [email, ip] = track('L.u.na+alias@example.test', '192.0.2.7');

    const replies = await Promise.all(
      Array.from({ length: 12 }, () => admitResetRequest(email, ip)),
    );
    expect(allowed(replies), 'to have length', 1);

    const keys = passwordResetKeys(email, ip);
    const [ipTTL, countTTL, cooldownTTL] = await Promise.all([
      database.ttl(keys.ipAttempts),
      database.ttl(keys.emailAdmitted),
      database.ttl(keys.emailCooldown),
    ]);
    expect(ipTTL, 'to be within', 1, LIMITS.perIP.intervalSec);
    expect(countTTL, 'to be within', 1, LIMITS.perEmail.intervalSec);
    expect(cooldownTTL, 'to be within', 1, LIMITS.emailCooldownSec);

    // A denied request must not extend any expiry
    const denied = await admitResetRequest(email, ip);
    expect(denied.allowed, 'to be false');

    const [ipTTL2, countTTL2, cooldownTTL2] = await Promise.all([
      database.ttl(keys.ipAttempts),
      database.ttl(keys.emailAdmitted),
      database.ttl(keys.emailCooldown),
    ]);
    expect(ipTTL2, 'to be less than or equal to', ipTTL);
    expect(countTTL2, 'to be less than or equal to', countTTL);
    expect(cooldownTTL2, 'to be less than or equal to', cooldownTTL);
  });

  it('should keep key names opaque and namespaced', () => {
    const [email, ip] = track('opaque@example.test', '192.0.2.8');
    const keys = passwordResetKeys(email, ip);

    for (const key of Object.values(keys)) {
      expect(key, 'to begin with', 'password-reset:v1:');
      expect(key, 'not to contain', 'opaque');
      expect(key, 'not to contain', '192.0.2.8');
    }
  });

  it('should share one email bucket across case, dot and plus variants', async () => {
    const [first, ip1] = track('User.Name+tag@Example.Test', '192.0.2.11');
    const [, ip2] = track('username@example.test', '192.0.2.12');

    expect((await admitResetRequest(first, ip1)).allowed, 'to be true');

    const denied = await admitResetRequest('username@example.test', ip2);
    expect(denied, 'to satisfy', { allowed: false, scope: 'email' });

    if (!denied.allowed) {
      expect(denied.retryAfterSeconds, 'to be a number');
      expect(denied.retryAfterSeconds, 'to be greater than', 0);
    }
  });

  it('should share one IP bucket across IPv4 and mapped IPv6 forms', async () => {
    const v4 = '192.0.2.13';
    const v6 = '::ffff:192.0.2.13';

    // Three admissions from equivalent addresses exhaust the per-IP count of 3
    for (const [i, ip] of [v4, v6, v4].entries()) {
      const [email] = track(`ip-share-${i}@example.test`, ip);
      // eslint-disable-next-line no-await-in-loop
      expect((await admitResetRequest(email, ip)).allowed, 'to be true');
    }

    const [email, ip] = track('ip-share-3@example.test', v6);
    const denied = await admitResetRequest(email, ip);
    expect(denied, 'to satisfy', { allowed: false, scope: 'ip' });
  });

  it('should enforce the hourly email cap across independent IPs', async () => {
    const [email] = track('hourly-cap@example.test', '192.0.2.14');
    const ips = ['192.0.2.14', '192.0.2.15', '192.0.2.16'];
    ips.forEach((ip) => track(email, ip));

    for (const ip of ips.slice(0, 2)) {
      // eslint-disable-next-line no-await-in-loop
      expect((await admitResetRequest(email, ip)).allowed, 'to be true');
      // Simulate cooldown expiry; the hourly counter must survive it
      // eslint-disable-next-line no-await-in-loop
      await database.del(passwordResetKeys(email, ip).emailCooldown);
    }

    const denied = await admitResetRequest(email, ips[2]);
    expect(denied, 'to satisfy', { allowed: false, scope: 'email' });
  });

  it('should keep completion attempts in a separate IP keyspace', async () => {
    const ip = '192.0.2.17';

    // Exhaust the initiation IP bucket first
    for (let i = 0; i < LIMITS.perIP.count; i++) {
      const [email] = track(`completion-iso-${i}@example.test`, ip);
      // eslint-disable-next-line no-await-in-loop
      expect((await admitResetRequest(email, ip)).allowed, 'to be true');
    }

    const [email] = track('completion-iso-x@example.test', ip);
    expect(await admitResetRequest(email, ip), 'to satisfy', { allowed: false, scope: 'ip' });

    // Completion attempts use their own counter
    for (let i = 0; i < LIMITS.completionPerIP.count; i++) {
      // eslint-disable-next-line no-await-in-loop
      expect((await admitResetCompletion(ip)).allowed, 'to be true');
    }

    expect(await admitResetCompletion(ip), 'to satisfy', { allowed: false, scope: 'ip' });
  });

  it('should fail closed on malformed and empty IP addresses', async () => {
    const [email, ip] = track('bad-ip@example.test', '192.0.2.18');

    for (const badIp of ['not-an-ip', '', '999.1.1.1', '::ffff:999.1.1.1']) {
      // eslint-disable-next-line no-await-in-loop
      expect(await admitResetRequest(email, badIp), 'to satisfy', {
        allowed: false,
        scope: 'ip',
      });
      // eslint-disable-next-line no-await-in-loop
      expect(await admitResetCompletion(badIp), 'to satisfy', { allowed: false, scope: 'ip' });
    }

    // The fixture bucket itself must be untouched by those denials
    expect((await admitResetRequest(email, ip)).allowed, 'to be true');
  });
});

describe('Password reset admission when disabled', () => {
  withModifiedConfig({ passwordReset: { rateLimit: { ...LIMITS, enabled: false } } });

  it('should allow without touching Redis', async () => {
    const email = 'disabled@example.test';
    const ip = '192.0.2.19';

    expect((await admitResetRequest(email, ip)).allowed, 'to be true');
    expect((await admitResetCompletion(ip)).allowed, 'to be true');

    const keys = passwordResetKeys(email, ip);
    const ttls = await Promise.all(Object.values(keys).map((k) => database.ttl(k)));
    expect(ttls, 'to equal', [-2, -2, -2, -2]);
  });
});

describe('Password reset admission with invalid limits', () => {
  withModifiedConfig({
    passwordReset: { rateLimit: { ...LIMITS, perIP: { count: 0, intervalSec: 3600 } } },
  });

  it('should reject admission instead of running with a zero limit', async () => {
    await expect(
      admitResetRequest('invalid-limits@example.test', '192.0.2.20'),
      'to be rejected with',
      /passwordReset\.rateLimit/,
    );
  });
});
