import fs from 'fs';

import createDebug from 'debug';
import Application, { type DefaultState } from 'koa';
import config from 'config';
import { koaBody } from 'koa-body';
import methodOverride from 'koa-methodoverride';
import morgan from 'koa-morgan';
import responseTime from 'koa-response-time';
import conditional from 'koa-conditional-get';
import etag from '@koa/etag';
import koaStatic from 'koa-static';
import requestId from 'koa-requestid';

import pkg from '../package.json' with { type: 'json' };

import { koaServerTiming } from './support/koa-server-timing';
import { originMiddleware } from './setup/initializers/origin';
import { maintenanceCheck } from './support/maintenance';
import { outerErrorMiddleware, reportError } from './support/exceptions';
import { normalizeInputStrings } from './controllers/middlewares/normalize-input';
import { type AppContext } from './support/types';
import { apiVersionMiddleware } from './setup/initializers/api-version';
import { asyncContextMiddleware } from './support/app-async-context';
import { nodeDirname } from './support/node-dirname';
import { safeRequestPath, safeRequestSummary } from './support/safe-request-summary';

const __dirname = nodeDirname(import.meta.url);

const env = process.env.NODE_ENV || 'development';

class FreefeedApp extends Application<DefaultState, AppContext> {
  constructor(options: Record<string, unknown> | undefined = {}) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore  // error in ts-definition
    super(options);

    if (config.trustProxyHeaders) {
      this.proxy = true;
      this.proxyIpHeader = config.proxyIpHeader;
    }

    this.context.config = config;
    this.context.port = process.env.PORT ? parseInt(process.env.PORT) : config.port;

    // First: adapt failures thrown before the main error handler below (body
    // parsing, static serving). The main handler stays after requestId so
    // application errors keep their request IDs.
    this.use(outerErrorMiddleware);

    this.use(asyncContextMiddleware);

    this.use(
      koaBody({
        multipart: true,
        formLimit: config.attachments.fileSizeLimit,
        jsonLimit: config.attachments.fileSizeLimit,
        textLimit: config.attachments.fileSizeLimit,
        formidable: { maxFileSize: config.attachments.fileSizeLimit },
      }),
    );
    this.use((ctx, next) => {
      // Compatibility fix with koa-body 4.*: use `{}` as default value of body
      // when it is empty.
      ctx.request.body ??= {};
      return next();
    });
    this.use(originMiddleware);
    this.use(apiVersionMiddleware);
    this.use(
      methodOverride((req) => {
        if (req.body && typeof req.body === 'object' && '_method' in req.body) {
          // look in urlencoded POST bodies and delete it
          const method = req.body._method as string;
          Reflect.deleteProperty(req.body, '_method');
          return method;
        }

        return undefined as unknown as string; // otherwise, no need to override
      }),
    );

    this.use(async (ctx, next) => {
      ctx.response.set('X-Freefeed-Server', pkg.version);
      await next();
    });

    // Access log without query strings, Referer or reset tokens; the request ID
    // lets entries be correlated with diagnostics
    morgan.token('safe-url', (req) => safeRequestPath(req.url ?? ''));
    const accessLogStream = fs.createWriteStream(`${__dirname}/../log/${env}.log`, { flags: 'a' });
    this.use(
      morgan(
        ':remote-addr - :remote-user [:date[clf]] ":method :safe-url HTTP/:http-version"' +
          ' :status :res[content-length] :res[X-Request-Id] ":user-agent" :response-time ms',
        { stream: accessLogStream },
      ),
    );

    if (config.logResponseTime) {
      // should be located BEFORE responseTime
      const timeLogger = createDebug('freefeed:request');
      this.use(async (ctx, next) => {
        await next();

        const time = ctx.response.get('X-Response-Time');
        const { method, path } = safeRequestSummary(ctx);
        const resource = (method + path).toLowerCase();

        timeLogger(resource, time);
      });
    }

    this.use(responseTime());
    this.use(koaServerTiming());

    if (config.attachments.storage.type === 'fs') {
      this.use(koaStatic(`${__dirname}/../${config.attachments.storage.rootDir}`));
    }

    this.use(maintenanceCheck);

    this.use(requestId({ expose: 'X-Request-Id', header: false, query: false }));

    this.use(async (ctx, next) => {
      try {
        await next();
      } catch (e) {
        reportError(ctx)(e);
      }
    });

    // naive (hash-based) implementation of ETags for dynamic content
    this.use(conditional());
    this.use(etag());
    this.use(normalizeInputStrings);
  }
}

export default FreefeedApp;
