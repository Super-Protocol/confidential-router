import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app/app.module.js';
import { configureApp, logStartup } from './app/bootstrap.js';
import { routerConfig } from './app/config.js';

async function bootstrap(): Promise<void> {
  // `bodyParser: false` is required — see `configureApp`.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });
  const config = app.get<ConfigType<typeof routerConfig>>(routerConfig.KEY);

  configureApp(app, config);
  app.enableShutdownHooks();

  await app.listen(config.server.port, config.server.host);
  logStartup(config);
}

bootstrap().catch((error) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
