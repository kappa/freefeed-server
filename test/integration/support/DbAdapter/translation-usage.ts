import expect from 'unexpected';

import cleanDB from '../../../dbCleaner';
import { dbAdapter } from '../../../../app/models';
import { createTestUser } from '../../../functional/functional_test_helper';
import { type UUID } from '../../../../app/support/types';

const thisDate = '2023-01-15T14:00:00Z';
const nextMonth = '2023-02-10T12:00:00Z';
const monthAfterNext = '2023-03-21T17:00:00Z';

describe('translationUsageTrait', () => {
  beforeEach(() => cleanDB(dbAdapter.database));

  describe('Service-wide value (period is month and userId is null)', () => {
    it('should register and read value', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      const usage = await dbAdapter.getTranslationUsage({ period: 'month', date: thisDate });
      expect(usage, 'to be', 42);
    });

    it('should register value and read it on next month', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      const usage = await dbAdapter.getTranslationUsage({ period: 'month', date: nextMonth });
      expect(usage, 'to be', 27.75); // ~1/3 of Feb is passed, so we see only ~2/3 of Jan's value (42)
    });

    it('should add value from prev month to this month', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      await dbAdapter.registerTranslationUsage({
        period: 'month',
        characters: 10,
        date: nextMonth,
      });
      const usage = await dbAdapter.getTranslationUsage({ period: 'month', date: nextMonth });
      expect(usage, 'to be', 37.75);
    });

    it('should not see value on month after next', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      await dbAdapter.registerTranslationUsage({
        period: 'month',
        characters: 10,
        date: monthAfterNext,
      });
      const usage = await dbAdapter.getTranslationUsage({ period: 'month', date: monthAfterNext });
      expect(usage, 'to be', 10);
    });

    it('should accumulate repeated registrations of the same month in one row', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 10, date: thisDate });
      const usage = await dbAdapter.getTranslationUsage({ period: 'month', date: thisDate });
      expect(usage, 'to be', 52);
      const rowCount = await dbAdapter.database.getOne<number>(
        `select count(*)::int from translation_usage where user_id is null`,
      );
      expect(rowCount, 'to be', 1);
    });
  });

  describe('Per-user value (period is day and userId is not null)', () => {
    let userId: UUID;

    beforeEach(async () => {
      userId = (await createTestUser()).user.id;
    });

    it('should register and read value', async () => {
      await dbAdapter.registerTranslationUsage({
        userId,
        period: 'day',
        characters: 42,
        date: thisDate,
      });
      const usage = await dbAdapter.getTranslationUsage({ userId, period: 'day', date: thisDate });
      expect(usage, 'to be', 42);
    });

    it('should accumulate repeated registrations of the same day in one row', async () => {
      await dbAdapter.registerTranslationUsage({
        userId,
        period: 'day',
        characters: 42,
        date: thisDate,
      });
      await dbAdapter.registerTranslationUsage({
        userId,
        period: 'day',
        characters: 10,
        date: thisDate,
      });
      const usage = await dbAdapter.getTranslationUsage({ userId, period: 'day', date: thisDate });
      expect(usage, 'to be', 52);
      const rowCount = await dbAdapter.database.getOne<number>(
        `select count(*)::int from translation_usage where user_id = :userId`,
        { userId },
      );
      expect(rowCount, 'to be', 1);
    });

    it('should not read value of another user', async () => {
      await dbAdapter.registerTranslationUsage({
        userId,
        period: 'day',
        characters: 42,
        date: thisDate,
      });
      const userId2 = (await createTestUser()).user.id;
      const usage = await dbAdapter.getTranslationUsage({
        userId: userId2,
        period: 'day',
        date: thisDate,
      });
      expect(usage, 'to be', 0);
    });
  });

  describe('Cleaning up', () => {
    it(`should clean up the old data and doesn't blow up`, async () => {
      await dbAdapter.cleanOldTranslationUsageData();
    });
  });

  describe('Atomic reservation (reserveTranslationUsage)', () => {
    let userId: UUID;
    let otherUserId: UUID;

    beforeEach(async () => {
      userId = (await createTestUser()).user.id;
      otherUserId = (await createTestUser()).user.id;
    });

    it('should admit exactly one of two competing user-budget reservations', async () => {
      const limits = { totalCharactersPerMonth: 10_000, userCharactersPerDay: 20 };
      const results = await Promise.all([
        dbAdapter.reserveTranslationUsage({ userId, characters: 11, limits }),
        dbAdapter.reserveTranslationUsage({ userId, characters: 11, limits }),
      ]);
      expect(
        results.filter((r) => r.allowed),
        'to have length',
        1,
      );
      expect(
        results.find((r) => !r.allowed),
        'to equal',
        { allowed: false, reason: 'user' },
      );
      // The denied reservation must not charge either counter
      expect(await dbAdapter.getTranslationUsage({ userId, period: 'day' }), 'to be', 11);
      expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 11);
    });

    it('should admit exactly one of two competing global-budget reservations', async () => {
      const limits = { totalCharactersPerMonth: 20, userCharactersPerDay: 10_000 };
      const results = await Promise.all([
        dbAdapter.reserveTranslationUsage({ userId, characters: 11, limits }),
        dbAdapter.reserveTranslationUsage({ userId: otherUserId, characters: 11, limits }),
      ]);
      expect(
        results.filter((r) => r.allowed),
        'to have length',
        1,
      );
      expect(
        results.find((r) => !r.allowed),
        'to equal',
        { allowed: false, reason: 'global' },
      );
      expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 11);
    });

    it('should allow an exactly fitting reservation and deny the next one', async () => {
      const limits = { totalCharactersPerMonth: 10_000, userCharactersPerDay: 20 };
      expect(
        await dbAdapter.reserveTranslationUsage({ userId, characters: 20, limits }),
        'to equal',
        { allowed: true },
      );
      expect(
        await dbAdapter.reserveTranslationUsage({ userId, characters: 1, limits }),
        'to equal',
        { allowed: false, reason: 'user' },
      );
      expect(await dbAdapter.getTranslationUsage({ userId, period: 'day' }), 'to be', 20);
      expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 20);
    });

    it('should deny positive-cost reservations against a zero budget', async () => {
      const limits = { totalCharactersPerMonth: 0, userCharactersPerDay: 0 };
      expect(
        await dbAdapter.reserveTranslationUsage({ userId, characters: 5, limits }),
        'to equal',
        { allowed: false, reason: 'global' },
      );
      expect(await dbAdapter.getTranslationUsage({ userId, period: 'day' }), 'to be', 0);
      expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 0);
    });

    it('should account previous-period usage with the injected date', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      const limits = { totalCharactersPerMonth: 30, userCharactersPerDay: 10_000 };
      // ~2/3 of January's 42 chars are still visible in February: 27.75 + 5 > 30
      expect(
        await dbAdapter.reserveTranslationUsage({
          userId,
          characters: 5,
          limits,
          date: nextMonth,
        }),
        'to equal',
        { allowed: false, reason: 'global' },
      );
    });

    it('should not see expired usage after window rollover', async () => {
      await dbAdapter.registerTranslationUsage({ period: 'month', characters: 42, date: thisDate });
      const limits = { totalCharactersPerMonth: 30, userCharactersPerDay: 10_000 };
      expect(
        await dbAdapter.reserveTranslationUsage({
          userId,
          characters: 5,
          limits,
          date: monthAfterNext,
        }),
        'to equal',
        { allowed: true },
      );
    });

    it('should reject a negative cost', async () => {
      const limits = { totalCharactersPerMonth: 10_000, userCharactersPerDay: 20 };
      await expect(
        () => dbAdapter.reserveTranslationUsage({ userId, characters: -1, limits }),
        'to be rejected with',
        /Invalid translation usage cost/,
      );
    });

    it('should reject a non-finite configured limit', async () => {
      const limits = { totalCharactersPerMonth: Number.NaN, userCharactersPerDay: 20 };
      await expect(
        () => dbAdapter.reserveTranslationUsage({ userId, characters: 1, limits }),
        'to be rejected with',
        /Invalid translation limit/,
      );
    });
  });
});
