import expect from 'unexpected';

import {
  metricLanguage,
  metricLabelLanguages,
} from '../../app/support/translation/metric-language';

describe('metricLanguage', () => {
  it('should map regional tags to their base language', () => {
    expect(metricLanguage('ru-RU'), 'to be', 'ru');
    expect(metricLanguage('en-US'), 'to be', 'en');
    expect(metricLanguage('zh-Hant-TW'), 'to be', 'zh');
  });

  it('should be case-insensitive', () => {
    expect(metricLanguage('RU-ru'), 'to be', 'ru');
    expect(metricLanguage('EN'), 'to be', 'en');
  });

  it('should map missing values to unknown', () => {
    expect(metricLanguage(undefined), 'to be', 'unknown');
    expect(metricLanguage(null), 'to be', 'unknown');
    expect(metricLanguage(''), 'to be', 'unknown');
  });

  it('should map unknown but well-formed codes to other', () => {
    expect(metricLanguage('xx'), 'to be', 'other');
    expect(metricLanguage('cz'), 'to be', 'other');
    // Reversed 'ru-RU', shaped like the test provider's detectedLang output
    expect(metricLanguage('UR-ur'), 'to be', 'other');
  });

  it('should map malformed, oversized and non-string values to other', () => {
    expect(metricLanguage('en-'), 'to be', 'other');
    expect(metricLanguage('not a lang!'), 'to be', 'other');
    expect(metricLanguage('a'.repeat(65)), 'to be', 'other');
    expect(metricLanguage(42), 'to be', 'other');
    expect(metricLanguage({}), 'to be', 'other');
  });

  it('should keep the checked-in label vocabulary fixed', () => {
    expect(metricLabelLanguages, 'to equal', [
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
  });

  it('should map 1000 distinct invalid inputs into the finite vocabulary', () => {
    const allowed = new Set([...metricLabelLanguages, 'unknown', 'other']);
    const results = new Set<string>();

    for (let i = 0; i < 1000; i++) {
      results.add(metricLanguage(`xx-invalid-${i}-${'!'.repeat(i % 70)}`));
    }

    expect(results.size > 0, 'to be', true);
    expect(
      [...results].every((label) => allowed.has(label)),
      'to be',
      true,
    );
    expect(results.size <= allowed.size, 'to be', true);
  });
});
