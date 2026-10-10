// Finite vocabulary of base language codes used in translation metric labels.
// Cardinality-sensitive: never add members derived from runtime input. The
// full label set is this list plus the 'unknown' and 'other' buckets, so any
// consumer of these labels stays at a calculable finite bound.
export const metricLabelLanguages: readonly string[] = Object.freeze([
  'ar',
  'be',
  'de',
  'en',
  'es',
  'fa',
  'fr',
  'he',
  'hi',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt',
  'ru',
  'sv',
  'tr',
  'uk',
  'zh',
]);

const labels = new Set(metricLabelLanguages);

export function metricLanguage(value: unknown): string {
  if (value == null || value === '') return 'unknown';

  if (typeof value !== 'string' || value.length > 64) return 'other';

  try {
    const [canonical] = Intl.getCanonicalLocales(value);
    const base = canonical?.split('-')[0];
    return base && labels.has(base) ? base : 'other';
  } catch {
    return 'other';
  }
}
