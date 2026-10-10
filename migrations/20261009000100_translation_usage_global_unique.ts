import { type Knex } from 'knex';

// The original unique (user_id, period, date) constraint does not deduplicate
// NULL user_id rows (service-wide counters): repeated global registrations
// accumulated in separate rows while readers saw only one of them. Merge the
// duplicates and enforce a single global row per (period, date) with a partial
// unique index. Deploy in a translation maintenance window: mixed old/new
// writers are unsafe because the old global upsert conflicts with the new
// index. On rollback, merged counts stay merged.
export const up = async (knex: Knex) => {
  await knex.raw(`lock table translation_usage in access exclusive mode`);
  await knex.raw(`create temp table translation_usage_global_merged on commit drop as
    select period, date, sum(characters)::bigint as characters
    from translation_usage where user_id is null group by period, date`);
  await knex.raw(`do $$begin
    if exists (
      select 1 from translation_usage_global_merged where characters > 2147483647
    ) then
      raise exception 'translation_usage migration: merged global usage exceeds integer range, manual cleanup required';
    end if;
  end$$`);
  await knex.raw(`delete from translation_usage where user_id is null`);
  await knex.raw(`insert into translation_usage (user_id, period, date, characters)
    select null, period, date, characters from translation_usage_global_merged`);
  await knex.raw(`create unique index translation_usage_global_period_date_unique
    on translation_usage (period, date) where user_id is null`);
};

export const down = (knex: Knex) =>
  knex.raw(`drop index translation_usage_global_period_date_unique`);
