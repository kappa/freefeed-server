import { createHash } from 'crypto';

import monitor from 'monitor-dog';
import compose from 'koa-compose';
import { type Context } from 'koa';

import {
  authRequired,
  commentAccessRequired,
  monitored,
  postAccessRequired,
} from '../../middlewares';
import { type User, type Post, type Comment, dbAdapter } from '../../../models';
import { type Ctx } from '../../../support/types';
import {
  ForbiddenException,
  ServerErrorException,
  ValidationException,
} from '../../../support/exceptions';
import { translate as translateText } from '../../../support/translation/translation';
import { metricLanguage } from '../../../support/translation/metric-language';

type TranslationResult = Awaited<ReturnType<typeof translateText>>;

export const getTranslatedBody = compose([
  authRequired(),
  async (ctx: Context, next) => {
    if (ctx.params.commentId) {
      await compose([
        monitored('translated-body', { entity: 'comment' }),
        commentAccessRequired({ mustBeVisible: true }),
      ])(ctx, next);
    } else if (ctx.params.postId) {
      await compose([monitored('translated-body', { entity: 'post' }), postAccessRequired()])(
        ctx,
        next,
      );
    } else {
      throw new ServerErrorException(
        `Server misconfiguration: the required parameters 'postId' or 'commentId' are missing`,
      );
    }
  },
  async (ctx: Ctx<{ user: User; post?: Post; comment?: Comment }>): Promise<void> => {
    const { user } = ctx.state;

    if (!ctx.config.translation.enabled) {
      throw new ForbiddenException('Translation is disabled on this server');
    }

    const targetLang = getTargetLang(ctx);
    const text = (ctx.state.comment ? ctx.state.comment.body : ctx.state.post?.body) ?? '';

    if (!text) {
      ctx.body = {
        translatedText: '',
        detectedLang: targetLang,
      } as TranslationResult;
      return;
    }

    const cacheKey = createHash('sha1').update(text).update(':').update(targetLang).digest('hex');

    let result: TranslationResult | undefined;
    let cacheHit = true;
    let overQuote = false;

    try {
      result = await dbAdapter.cache.get<TranslationResult>(cacheKey);

      if (!result) {
        cacheHit = false;

        // Charge text.length (UTF-16 code units) against the approximate
        // sliding-window budgets before calling the provider. A denied
        // reservation charges nothing; an allowed one stays charged even if
        // the provider call or caching fails below (no refunds).
        const reservation = await dbAdapter.reserveTranslationUsage({
          userId: user.id,
          characters: text.length,
          limits: ctx.config.translation.limits,
        });

        if (!reservation.allowed) {
          overQuote = true;
          throw new ForbiddenException(
            'You have reached the limit of allowed translations. Please try again later.',
          );
        }

        result = await translateText(text, targetLang, ctx.config);

        // Save the translation in the cache
        await dbAdapter.cache.set(cacheKey, result);
      }

      ctx.body = result;
    } finally {
      const statTags = {
        detectedLang: metricLanguage(result?.detectedLang),
        targetLang: metricLanguage(targetLang),
        cacheHit: cacheHit ? 'true' : 'false',
        overQuote: overQuote ? 'true' : 'false',
      };

      monitor.increment('translation-usage', text.length, statTags);
      monitor.increment('translation-requests', 1, statTags);
    }
  },
]);

function getTargetLang(ctx: Ctx): string {
  let { lang } = ctx.request.query;

  if (Array.isArray(lang)) {
    [lang] = lang;
  }

  if (!lang) {
    [lang] = ctx.request.acceptsLanguages();
  }

  if (!lang || lang === '*') {
    lang = 'en';
  }

  if (lang.length > 64 || !isWellFormedLanguageTag(lang)) {
    throw new ValidationException('Invalid language tag');
  }

  return lang;
}

function isWellFormedLanguageTag(lang: string): boolean {
  try {
    Intl.getCanonicalLocales(lang);
    return true;
  } catch {
    return false;
  }
}
