import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { SignInOptionsService } from './sign-in-options.service.js';

type RouterConfigType = ConfigType<typeof routerConfig>;

function build(auth: Partial<RouterConfigType['auth']>, hasUser = false, mail: Partial<RouterConfigType['mail']> = {}) {
  const exists = vi.fn().mockResolvedValue(hasUser);
  const dataSource = { getRepository: () => ({ exists }) } as unknown as DataSource;
  const config = {
    server: { publicBaseUrl: 'http://localhost:3000', validClientOrigins: ['http://localhost:4200'] },
    mail: { fromName: 'Confidential Router', ...mail },
    auth: { magicLink: { mailer: 'console' }, bootstrapEmail: 'admin@example.com', ...auth },
  } as RouterConfigType;

  return { service: new SignInOptionsService(dataSource, config), exists };
}

describe('SignInOptionsService', () => {
  it('reports the OAuth apps this deployment has, and only those', async () => {
    const { service } = build({ github: { clientId: 'id', clientSecret: 'secret' } });

    await expect(service.get()).resolves.toMatchObject({ github: true, google: false });
  });

  it('reports magic link as unavailable when the mailer is switched off', async () => {
    await expect(build({ magicLink: { mailer: 'none' } as never }).service.get()).resolves.toMatchObject({
      magicLink: false,
    });
  });

  it('keeps magic link off when the deployment says so, even with a mailer (SUP-269)', async () => {
    const options = await build({ magicLink: { mailer: 'none', enabled: false } as never }, false, {
      provider: 'smtp',
    }).service.get();

    expect(options).toMatchObject({ magicLink: false });
  });

  it('offers magic link from the `mail` section alone', async () => {
    const options = await build({ magicLink: { mailer: 'none' } as never }, false, { provider: 'smtp' }).service.get();

    expect(options).toMatchObject({ magicLink: true });
  });

  it('offers the emailed code exactly while there is a mailer (SUP-269)', async () => {
    await expect(build({}).service.get()).resolves.toMatchObject({ emailCode: true, emailCodeLength: 6 });
    await expect(build({}, false, { provider: 'none' }).service.get()).resolves.toMatchObject({ emailCode: false });
    await expect(build({ magicLink: { mailer: 'none' } as never }).service.get()).resolves.toMatchObject({
      emailCode: false,
    });
  });

  it('reports nothing about passwords: there are none', async () => {
    const options = await build({}).service.get();

    expect(Object.keys(options).filter((key) => /password/i.test(key))).toEqual([]);
  });

  it('offers bootstrap while a token is configured and the deployment is empty', async () => {
    const { service, exists } = build({ bootstrapToken: 't'.repeat(16) }, false);

    await expect(service.get()).resolves.toMatchObject({ bootstrap: true });
    expect(exists).toHaveBeenCalled();
  });

  it('withdraws bootstrap once the deployment has a user', async () => {
    await expect(build({ bootstrapToken: 't'.repeat(16) }, true).service.get()).resolves.toMatchObject({
      bootstrap: false,
    });
  });

  it('does not touch the database when no token is configured', async () => {
    const { service, exists } = build({});

    await expect(service.get()).resolves.toMatchObject({ bootstrap: false });
    expect(exists).not.toHaveBeenCalled();
  });

  it('offers administrator recovery once the token’s own account exists, instead of bootstrap', async () => {
    const { service, exists } = build({ bootstrapToken: 't'.repeat(16), bootstrapEmail: 'Admin@Example.com' }, true);

    await expect(service.get()).resolves.toMatchObject({ bootstrap: false, adminRecovery: true });
    // Looked up the way Better Auth stores it.
    expect(exists).toHaveBeenLastCalledWith({ where: { email: 'admin@example.com' } });
  });

  it('offers neither on an empty deployment’s recovery, nor recovery without a token', async () => {
    await expect(build({ bootstrapToken: 't'.repeat(16) }, false).service.get()).resolves.toMatchObject({
      bootstrap: true,
      adminRecovery: false,
    });
    await expect(build({}, true).service.get()).resolves.toMatchObject({ bootstrap: false, adminRecovery: false });
  });

  it('never reports the token itself', async () => {
    const token = 'secret-bootstrap-token';
    const { service } = build({ bootstrapToken: token });

    expect(JSON.stringify(await service.get())).not.toContain(token);
  });
});
