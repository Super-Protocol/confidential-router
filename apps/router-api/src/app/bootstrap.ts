import { Logger, ValidationPipe } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { toNodeHandler } from 'better-auth/node';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AUTH_BASE_PATH, AuthService } from './auth/index.js';
import type { routerConfig } from './config.js';

/**
 * Mounted as a prefix (`/auth`), not a wildcard pattern (`/auth/{*path}`).
 *
 * Better Auth rebuilds the request URL from `req.baseUrl + req.url` and only
 * trusts the result when it equals `req.originalUrl`. A wildcard mount makes
 * Express put the whole path in `baseUrl` and just `/` in `url`, the two stop
 * matching, and the library falls back to a URL with the query string dropped —
 * which silently breaks every callback that carries a token.
 */
export const AUTH_HANDLER_ROUTE = AUTH_BASE_PATH;

/**
 * Everything that has to happen to a created Nest app before it can listen,
 * shared by `main.ts` and the e2e tests so the two exercise the same middleware
 * stack — a CORS or Helmet difference between them would make the tests worth
 * very little.
 *
 * The app must be created with `{ bodyParser: false }`: Better Auth's handler
 * reads the raw request stream, so it is mounted before any body parser and the
 * JSON parser is installed after it.
 */
export function configureApp(app: NestExpressApplication, config: ConfigType<typeof routerConfig>): void {
  app.useLogger(app.get(PinoLogger));
  app.set('trust proxy', 1);

  app.use(
    helmet({
      // The API serves JSON and the Swagger UI; it embeds nothing and is
      // embedded by nothing.
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], frameAncestors: ["'none'"] } },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    credentials: true,
    origin: (origin, callback) => {
      const allowed = config.server.validClientOrigins;
      // A request with no Origin is same-origin or a non-browser client; the
      // session cookie is `SameSite=Lax`, so it is not a CSRF vector.
      if (!origin || allowed.includes('*') || allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed`));
    },
  });

  // Order matters: raw stream to Better Auth, parsed bodies to everything else.
  app.use(AUTH_HANDLER_ROUTE, toNodeHandler(app.get(AuthService).handler));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  if (config.swagger.enabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Confidential Router API')
        .setDescription('Console REST surface. The OpenAI-compatible /v1 surface is documented separately.')
        .setVersion('1')
        .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'API key: sk-tee-v1-…' })
        .build(),
    );
    SwaggerModule.setup(config.swagger.path, app, document, { useGlobalPrefix: false });
  }
}

export function logStartup(config: ConfigType<typeof routerConfig>): void {
  const logger = new Logger('Bootstrap');
  const { host, port } = config.server;
  logger.log(`router-api listening on http://${host}:${port}`);
  logger.log(`GraphQL: ${config.graphql.path} · health: /health · auth: ${AUTH_BASE_PATH}/*`);
  if (config.swagger.enabled) {
    logger.log(`Swagger UI: /${config.swagger.path}`);
  }
  logger.log(`Database: ${config.database.type}`);
}
