import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { dump } from 'js-yaml';
import request from 'supertest';
import { AppModule } from '../src/app/app.module.js';
import { MAGIC_LINK_MAILER, type MagicLinkMailer, type MagicLinkMessage } from '../src/app/auth/index.js';
import { configureApp } from '../src/app/bootstrap.js';
import { routerConfig } from '../src/app/config.js';

/** Captures magic links instead of mailing them, so a test can follow one. */
export class CapturingMailer implements MagicLinkMailer {
  readonly sent: MagicLinkMessage[] = [];

  async send(message: MagicLinkMessage): Promise<void> {
    this.sent.push(message);
  }

  get last(): MagicLinkMessage {
    const message = this.sent.at(-1);
    if (!message) {
      throw new Error('No magic link was sent.');
    }
    return message;
  }
}

export interface Harness {
  app: INestApplication;
  mailer: CapturingMailer;
  close(): Promise<void>;
}

export interface HarnessOptions {
  /** `CR_API_*` overrides, applied on top of the suite defaults. */
  env?: Record<string, string>;
  /**
   * A `router.yaml` for this harness. Anything the schema accepts — the
   * `models[]` / `endpoints[]` catalogue in particular, which no environment
   * variable can express.
   */
  config?: Record<string, unknown>;
}

/**
 * Boots the real application — the same modules, the same middleware stack as
 * `main.ts` — against a throwaway SQLite file. Only the mailer is replaced;
 * everything an e2e test asserts (migrations, Better Auth, guards, GraphQL) is
 * the production wiring.
 */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cr-e2e-'));

  const configFile = join(dir, 'router.yaml');
  if (options.config) {
    writeFileSync(configFile, dump(options.config), 'utf8');
  }

  const env: Record<string, string> = {
    // Absolute, and only written when the test asked for one: never pick up the
    // repository's dev config.
    CR_API_CONFIG_FILE: options.config ? configFile : join(dir, 'absent.yaml'),
    CR_API_DATABASE__TYPE: 'sqlite',
    CR_API_DATABASE__FILE: join(dir, 'router.sqlite'),
    CR_API_DATABASE__MIGRATIONS_RUN: 'true',
    CR_API_SERVER__VALID_CLIENT_ORIGINS: 'http://localhost:4200',
    CR_API_AUTH__SECRET: 'e2e-secret-'.padEnd(48, 'x'),
    CR_API_AUTH__BASE_URL: 'http://localhost:3000',
    CR_API_LOG__LEVEL: 'silent',
    CR_API_SWAGGER__ENABLED: 'false',
    ...options.env,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  const mailer = new CapturingMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAGIC_LINK_MAILER)
    .useValue(mailer)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, bufferLogs: true });
  configureApp(app, app.get<ConfigType<typeof routerConfig>>(routerConfig.KEY));
  await app.init();

  return {
    app,
    mailer,
    close: async () => {
      await app.close();
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * A complete magic-link sign-in, returning the cookies a browser would keep.
 *
 * Shared because most console suites need a session before they can test
 * anything else; `auth.e2e.spec.ts` owns the assertions about the flow itself.
 */
export async function signIn(harness: Harness, email: string): Promise<string[]> {
  const server = harness.app.getHttpServer();
  await request(server).post('/auth/sign-in/magic-link').send({ email, callbackURL: '/' });
  const verify = await request(server).get(pathOf(harness.mailer.last.url));
  const cookies = verify.headers['set-cookie'];
  return Array.isArray(cookies) ? cookies : [cookies].filter(Boolean);
}

/**
 * Binds the harness to a loopback port and returns its base URL.
 *
 * Needed by the tests that cannot go through supertest: a real SSE reader and
 * the `openai` SDK both want a URL and an incremental response body.
 */
export async function listen(harness: Harness): Promise<string> {
  await harness.app.listen(0, '127.0.0.1');
  return (await harness.app.getUrl()).replace('[::1]', '127.0.0.1');
}

/** Turns an absolute magic-link URL into the path supertest needs. */
export function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}
