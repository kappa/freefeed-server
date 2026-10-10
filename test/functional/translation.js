/* eslint-disable no-await-in-loop */
/* global $pg_database */
import expect from 'unexpected';
import { spy, stub } from 'sinon';

import cleanDB from '../dbCleaner';
import { dbAdapter } from '../../app/models';

import {
  createTestUsers,
  createAndReturnPost,
  performJSONRequest,
  authHeaders,
  createCommentAsync,
  goPrivate,
  withModifiedAppConfig,
} from './functional_test_helper';

describe('Text translation', () => {
  let luna, mars;
  let post, comment;

  beforeEach(() => cleanDB($pg_database));

  beforeEach(async () => {
    [luna, mars] = await createTestUsers(['luna', 'mars']);
    post = await createAndReturnPost(luna, 'Just a post');
    comment = await createCommentAsync(luna, post.id, 'Just a comment')
      .then((r) => r.json())
      .then((r) => r.comments);
  });

  it(`should not allow anonymous user to translate post`, async () => {
    const result = await translatePost(post.id);
    expect(result, 'to satisfy', { __httpCode: 401 });
  });

  it(`should not allow anonymous user to translate comment`, async () => {
    const result = await translateComment(comment.id);
    expect(result, 'to satisfy', { __httpCode: 401 });
  });

  it(`should allow Mars to translate post`, async () => {
    const result = await translatePost(post.id, mars);
    expect(result, 'to satisfy', {
      __httpCode: 200,
      translatedText: 'tsop a tsuJ',
      detectedLang: 'ne',
    });
  });

  it(`should allow Mars to translate post to 'ru-RU'`, async () => {
    const result = await translatePost(post.id, mars, 'ru-RU');
    expect(result, 'to satisfy', {
      __httpCode: 200,
      translatedText: 'tsop a tsuJ',
      detectedLang: 'UR-ur',
    });
  });

  it(`should allow Mars to translate post to 'ru-RU' using Accept-Language header`, async () => {
    const result = await performJSONRequest('GET', `/v2/posts/${post.id}/translated-body`, null, {
      ...authHeaders(mars),
      'Accept-Language': 'ru-RU,en,cz',
    });
    expect(result, 'to satisfy', {
      __httpCode: 200,
      translatedText: 'tsop a tsuJ',
      detectedLang: 'UR-ur',
    });
  });

  it(`should allow Mars to translate comment`, async () => {
    const result = await translateComment(comment.id, mars);
    expect(result, 'to satisfy', {
      __httpCode: 200,
      translatedText: 'tnemmoc a tsuJ',
      detectedLang: 'ne',
    });
  });

  describe('Luna became private', () => {
    beforeEach(() => goPrivate(luna));

    it(`should allow Luna to translate post`, async () => {
      const result = await translatePost(post.id, luna);
      expect(result, 'to satisfy', {
        __httpCode: 200,
        translatedText: 'tsop a tsuJ',
        detectedLang: 'ne',
      });
    });

    it(`should allow Luna to translate comment`, async () => {
      const result = await translateComment(comment.id, luna);
      expect(result, 'to satisfy', {
        __httpCode: 200,
        translatedText: 'tnemmoc a tsuJ',
        detectedLang: 'ne',
      });
    });

    it(`should not allow Mars to translate post`, async () => {
      const result = await translatePost(post.id, mars);
      expect(result, 'to satisfy', { __httpCode: 403 });
    });

    it(`should not allow Mars to translate comment`, async () => {
      const result = await translateComment(comment.id, mars);
      expect(result, 'to satisfy', { __httpCode: 403 });
    });
  });

  describe('Limits', () => {
    withModifiedAppConfig({
      translation: {
        limits: {
          userCharactersPerDay: 20,
        },
      },
    });

    beforeEach(() => dbAdapter.cache.clear());

    it(`should allow to translate the same text multiple times thanks to caching`, async () => {
      for (let i = 0; i < 5; i++) {
        const result = await translatePost(post.id, mars);
        expect(result, 'to satisfy', { __httpCode: 200 });
      }
    });

    it(`should reach the limit without caching`, async () => {
      {
        const result = await translatePost(post.id, mars);
        await dbAdapter.cache.clear();
        expect(result, 'to satisfy', { __httpCode: 200 });
      }

      {
        // 'Just a post' is 11 chars, so the second translation would exceed
        // the 20-char budget and must be denied before calling the provider
        const result = await translatePost(post.id, mars);
        await dbAdapter.cache.clear();
        expect(result, 'to satisfy', {
          __httpCode: 403,
          err: 'You have reached the limit of allowed translations. Please try again later.',
        });
      }
    });

    it(`should not charge, call the provider or cache anything when over quota`, async () => {
      // dbAdapter.cache is shared by the whole request pipeline, so count
      // only translation result writes
      const cacheSetSpy = spy(dbAdapter.cache, 'set');

      try {
        expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 200 });
        await dbAdapter.cache.clear();
        expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 403 });
        // A denied translation leaves nothing in the cache, so the next
        // request misses again and is denied again instead of hitting the cache
        expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 403 });
        // Only the successful translation was cached
        const translationWrites = cacheSetSpy.args.filter(([, value]) =>
          isTranslationResult(value),
        );
        expect(translationWrites.length, 'to be', 1);
        expect(
          await dbAdapter.getTranslationUsage({ userId: mars.user.id, period: 'day' }),
          'to be',
          11,
        );
        expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 11);
      } finally {
        cacheSetSpy.restore();
      }
    });

    it(`should serve cache hits after the budget is exhausted for new texts`, async () => {
      expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 200 });
      // 'Just a comment' is 14 chars, 11 + 14 exceeds the 20-char budget
      expect(await translateComment(comment.id, mars), 'to satisfy', { __httpCode: 403 });
      // The first translation is still served from the cache
      expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 200 });
      expect(
        await dbAdapter.getTranslationUsage({ userId: mars.user.id, period: 'day' }),
        'to be',
        11,
      );
    });

    it(`should admit exactly one of two simultaneous cache misses`, async () => {
      await dbAdapter.cache.clear();
      const results = await Promise.all([
        translatePost(post.id, mars),
        translatePost(post.id, mars),
      ]);
      expect(results.map((r) => r.__httpCode).sort(), 'to equal', [200, 403]);
      expect(
        await dbAdapter.getTranslationUsage({ userId: mars.user.id, period: 'day' }),
        'to be',
        11,
      );
      expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 11);
    });

    it(`should translate an empty post body without charging the budget`, async () => {
      await $pg_database.raw(`update posts set body = '' where uid = :postId`, {
        postId: post.id,
      });
      expect(await translatePost(post.id, mars), 'to satisfy', {
        __httpCode: 200,
        translatedText: '',
      });
      expect(
        await dbAdapter.getTranslationUsage({ userId: mars.user.id, period: 'day' }),
        'to be',
        0,
      );
      expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 0);
    });

    it(`should keep the reservation charged when caching the result fails`, async () => {
      // Fail only translation result writes; the rest of the request
      // pipeline shares this cache and must keep working
      const realSet = dbAdapter.cache.set.bind(dbAdapter.cache);
      const setStub = stub(dbAdapter.cache, 'set').callsFake((key, value, ...rest) =>
        isTranslationResult(value)
          ? Promise.reject(new Error('cache is down'))
          : realSet(key, value, ...rest),
      );

      try {
        expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 500 });
        expect(
          await dbAdapter.getTranslationUsage({ userId: mars.user.id, period: 'day' }),
          'to be',
          11,
        );
        expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 11);
      } finally {
        setStub.restore();
      }
    });

    describe('when the provider fails', () => {
      withModifiedAppConfig({ translation: { service: 'google', apiKey: 'test-key' } });

      let fetchStub;

      beforeEach(() => {
        const realFetch = globalThis.fetch;
        // Fail only provider calls, let the test harness HTTP calls through
        fetchStub = stub(globalThis, 'fetch').callsFake((url, ...rest) =>
          String(url).includes('translation.googleapis.com')
            ? Promise.reject(new Error('provider is down'))
            : realFetch(url, ...rest),
        );
      });

      afterEach(() => fetchStub.restore());

      it(`should keep the reservation charged`, async () => {
        expect(await translatePost(post.id, mars), 'to satisfy', { __httpCode: 500 });
        expect(
          await dbAdapter.getTranslationUsage({ userId: mars.user.id, period: 'day' }),
          'to be',
          11,
        );
        expect(await dbAdapter.getTranslationUsage({ period: 'month' }), 'to be', 11);
      });
    });
  });
});

function isTranslationResult(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    'translatedText' in value &&
    'detectedLang' in value
  );
}

function translatePost(postId, userCtx, lang = null) {
  const qs = lang ? `?lang=${lang}` : '';
  return performJSONRequest(
    'GET',
    `/v2/posts/${postId}/translated-body${qs}`,
    null,
    authHeaders(userCtx),
  );
}

function translateComment(commentId, userCtx, lang = null) {
  const qs = lang ? `?lang=${lang}` : '';
  return performJSONRequest(
    'GET',
    `/v2/comments/${commentId}/translated-body${qs}`,
    null,
    authHeaders(userCtx),
  );
}
