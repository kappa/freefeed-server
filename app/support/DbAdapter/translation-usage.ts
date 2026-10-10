import { type TranslationLimits } from 'config';

import { type ISO8601DateTimeString, type UUID } from '../types';

import { advisoryLock, TRANSLATION_USAGE } from './adv-locks';

import { type DbAdapter } from './index';

export type RegisterOptions = {
  userId?: UUID | null;
  date?: ISO8601DateTimeString | 'now';
  period: 'day' | 'month';
  characters: number;
};

export type UsageOptions = {
  userId?: UUID | null;
  date?: ISO8601DateTimeString | 'now';
  period: 'day' | 'month';
};

export type ReserveOptions = {
  userId: UUID;
  characters: number;
  limits: TranslationLimits;
  date?: ISO8601DateTimeString | 'now';
};

export type ReserveResult = { allowed: true } | { allowed: false; reason: 'global' | 'user' };

// The query surface shared by the adapter connection and transaction objects
type UsageConn = {
  raw(sql: string, bindings?: Record<string, unknown>): Promise<unknown>;
  getOne<V>(sql: string, bindings?: Record<string, unknown>): Promise<V>;
};

async function registerUsage(
  conn: UsageConn,
  { userId = null, date = 'now', period, characters }: RegisterOptions,
): Promise<void> {
  // The plain unique constraint ignores NULL user_id rows, so global
  // counters use the partial unique index as the conflict target instead.
  const conflictTarget =
    userId === null
      ? `on conflict (period, date) where user_id is null do`
      : `on conflict (user_id, period, date) do`;
  await conn.raw(
    `insert into translation_usage (user_id, period, date, characters)
      values (:userId, :period, date_trunc(:period, :date::timestamptz), :characters)
      ${conflictTarget}
        update set characters = translation_usage.characters + excluded.characters`,
    { userId, period, date, characters },
  );
}

async function getUsage(
  conn: UsageConn,
  { userId = null, period, date = 'now' }: UsageOptions,
): Promise<number> {
  // Sequential queries: a transaction holds a single connection that can not
  // run queries concurrently
  const nowUsage = await conn.getOne<number | null>(
    `select characters from translation_usage where
    user_id is not distinct from :userId and period = :period
      and date = date_trunc(:period, :date::timestamptz)`,
    { userId, period, date },
  );
  const prevUsage = await conn.getOne<number | null>(
    `select characters from translation_usage where
    user_id is not distinct from :userId and period = :period 
      and date = date_trunc(:period, :date::timestamptz) - :step::interval`,
    { userId, period, date, step: `1 ${period}` },
  );
  const nowPart = await conn.getOne<number>(
    `select 
      (extract(epoch from :date::timestamptz)
        - extract(epoch from date_trunc(:period, :date::timestamptz)))
      /
      (extract(epoch from date_trunc(:period, :date::timestamptz) + :step::interval)
        - extract(epoch from date_trunc(:period, :date::timestamptz)))`,
    { date, period, step: `1 ${period}` },
  );

  // Sliding window approximation using the current and previous interval data
  return (nowUsage ?? 0) + (prevUsage ?? 0) * (1 - nowPart);
}

export default (superClass: typeof DbAdapter) =>
  class extends superClass {
    async registerTranslationUsage(options: RegisterOptions): Promise<void> {
      await registerUsage(this.database, options);
    }

    async getTranslationUsage(options: UsageOptions): Promise<number> {
      return await getUsage(this.database, options);
    }

    /**
     * Atomically check the service-wide monthly and per-user daily translation
     * budgets at a single instant and, if the cost fits both, charge it to
     * both counters. Concurrent reservations serialize on an advisory lock so
     * competing requests can not jointly overshoot either budget. A denied
     * reservation charges nothing; an allowed one stays charged even if the
     * caller never uses it (no refunds).
     *
     * The optional date is a test seam; production callers omit it and the
     * effective timestamp is read inside the lock.
     */
    async reserveTranslationUsage({
      userId,
      characters,
      limits,
      date = 'now',
    }: ReserveOptions): Promise<ReserveResult> {
      if (!Number.isSafeInteger(characters) || characters < 0) {
        throw new Error(`Invalid translation usage cost: ${characters}`);
      }

      const { totalCharactersPerMonth, userCharactersPerDay } = limits;

      for (const [name, value] of Object.entries({
        totalCharactersPerMonth,
        userCharactersPerDay,
      })) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new Error(`Invalid translation limit ${name}: ${value}`);
        }
      }

      return await this.database.transaction(async (trx) => {
        // withDbHelpers() wraps the transaction object with the query helpers
        // at runtime (see db-helpers.js), but its type is not visible here
        const conn = trx as unknown as UsageConn;
        await advisoryLock(trx, TRANSLATION_USAGE);

        // One effective timestamp for both budget computations, acquired after
        // the lock; an explicitly passed date keeps tests deterministic
        const now =
          date === 'now' ? await conn.getOne<string>(`select clock_timestamp()::text`) : date;

        const globalUsage = await getUsage(conn, { period: 'month', date: now });
        const userUsage = await getUsage(conn, { userId, period: 'day', date: now });

        if (globalUsage + characters > totalCharactersPerMonth) {
          return { allowed: false, reason: 'global' };
        }

        if (userUsage + characters > userCharactersPerDay) {
          return { allowed: false, reason: 'user' };
        }

        await registerUsage(conn, { period: 'month', characters, date: now });
        await registerUsage(conn, { userId, period: 'day', characters, date: now });

        return { allowed: true };
      });
    }

    async cleanOldTranslationUsageData(now: ISO8601DateTimeString | 'now' = 'now') {
      await this.database.raw(
        `delete from translation_usage where
          date < date_trunc(period, :now::timestamptz) - ('2 ' || period)::interval`,
        { now },
      );
    }
  };
