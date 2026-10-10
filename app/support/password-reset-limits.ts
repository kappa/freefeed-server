import crypto from 'crypto';

import database from '../setup/database';

import { currentConfig } from './app-async-context';
import { normalizeEmail } from './email-norm';
import { Address } from './ipv6';

export type ResetAdmission =
  { allowed: true } | { allowed: false; scope: 'ip' | 'email'; retryAfterSeconds: number };

export type PasswordResetKeys = {
  ipAttempts: string;
  emailAdmitted: string;
  emailCooldown: string;
  completionAttempts: string;
};

const KEY_PREFIX = 'password-reset:v1';

// KEYS: IP attempts, email admitted count, email cooldown.
// ARGV: IP window seconds, IP count, email window seconds,
//       email count, cooldown seconds.
const INITIATE_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if n > tonumber(ARGV[2]) then
  return {0, 1, math.max(redis.call('TTL', KEYS[1]), 1)}
end
local cooldown = redis.call('TTL', KEYS[3])
local sent = tonumber(redis.call('GET', KEYS[2]) or '0')
local retry = math.max(cooldown, 0)
if sent >= tonumber(ARGV[4]) then
  retry = math.max(retry, redis.call('TTL', KEYS[2]), 1)
end
if cooldown >= 0 or sent >= tonumber(ARGV[4]) then
  return {0, 2, math.max(retry, 1)}
end
local admitted = redis.call('INCR', KEYS[2])
if admitted == 1 then redis.call('EXPIRE', KEYS[2], ARGV[3]) end
redis.call('SET', KEYS[3], '1', 'EX', ARGV[5])
return {1, 0, 0}
`;

// KEYS: completion IP attempts. ARGV: window seconds, count.
const COMPLETE_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
if n > tonumber(ARGV[2]) then
  return {0, 1, math.max(redis.call('TTL', KEYS[1]), 1)}
end
return {1, 0, 0}
`;

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid passwordReset.rateLimit.${name}: expected a positive integer`);
  }
}

function enforcedLimits() {
  const { rateLimit } = currentConfig().passwordReset;

  if (rateLimit.enabled === false) {
    // Operator escape hatch: skip limiting entirely without touching Redis
    return null;
  }

  assertPositiveInt('perIP.count', rateLimit.perIP.count);
  assertPositiveInt('perIP.intervalSec', rateLimit.perIP.intervalSec);
  assertPositiveInt('perEmail.count', rateLimit.perEmail.count);
  assertPositiveInt('perEmail.intervalSec', rateLimit.perEmail.intervalSec);
  assertPositiveInt('emailCooldownSec', rateLimit.emailCooldownSec);
  assertPositiveInt('completionPerIP.count', rateLimit.completionPerIP.count);
  assertPositiveInt('completionPerIP.intervalSec', rateLimit.completionPerIP.intervalSec);

  return rateLimit;
}

function canonicalIP(ip: string): string | null {
  if (typeof ip !== 'string') {
    return null;
  }

  try {
    return new Address(ip).toString();
  } catch {
    return null;
  }
}

function bucketKey(secret: string, bucket: string, value: string): string {
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${KEY_PREFIX}:${bucket}:${value}`)
    .digest('hex');
  return `${KEY_PREFIX}:${bucket}:${mac}`;
}

/**
 * Redis keys for the given address and client IP. Exported so tests can clean
 * up only their own fixture keys; key suffixes are HMACs, never plaintext.
 */
export function passwordResetKeys(email: string, ip: string): PasswordResetKeys {
  const { secret } = currentConfig();
  const normEmail = normalizeEmail(email.trim());
  const canonical = new Address(ip).toString();

  return {
    ipAttempts: bucketKey(secret, 'init:ip', canonical),
    emailAdmitted: bucketKey(secret, 'init:email', normEmail),
    emailCooldown: bucketKey(secret, 'init:email-cooldown', normEmail),
    completionAttempts: bucketKey(secret, 'complete:ip', canonical),
  };
}

export async function admitResetRequest(email: string, ip: string): Promise<ResetAdmission> {
  const limits = enforcedLimits();

  if (limits === null) {
    return { allowed: true };
  }

  const canonical = canonicalIP(ip);

  if (canonical === null) {
    // Fail closed: an unparseable client address never bypasses the limiter
    return { allowed: false, scope: 'ip', retryAfterSeconds: limits.perIP.intervalSec };
  }

  const keys = passwordResetKeys(email, canonical);
  const [admitted, scope, retryAfter] = (await database.eval(
    INITIATE_SCRIPT,
    3,
    keys.ipAttempts,
    keys.emailAdmitted,
    keys.emailCooldown,
    limits.perIP.intervalSec,
    limits.perIP.count,
    limits.perEmail.intervalSec,
    limits.perEmail.count,
    limits.emailCooldownSec,
  )) as [number, number, number];

  if (admitted === 1) {
    return { allowed: true };
  }

  return {
    allowed: false,
    scope: scope === 2 ? 'email' : 'ip',
    retryAfterSeconds: retryAfter,
  };
}

export async function admitResetCompletion(ip: string): Promise<ResetAdmission> {
  const limits = enforcedLimits();

  if (limits === null) {
    return { allowed: true };
  }

  const canonical = canonicalIP(ip);

  if (canonical === null) {
    return { allowed: false, scope: 'ip', retryAfterSeconds: limits.completionPerIP.intervalSec };
  }

  const key = bucketKey(currentConfig().secret, 'complete:ip', canonical);
  const [admitted, , retryAfter] = (await database.eval(
    COMPLETE_SCRIPT,
    1,
    key,
    limits.completionPerIP.intervalSec,
    limits.completionPerIP.count,
  )) as [number, number, number];

  if (admitted === 1) {
    return { allowed: true };
  }

  return { allowed: false, scope: 'ip', retryAfterSeconds: retryAfter };
}
