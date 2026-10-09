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
    auth: { magicLink: { mailer: 'console' }, password: { enabled: false, minLength: 12 }, ...auth },
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

  it('offers password reset only with both passwords and a mailer (SUP-269)', async () => {
    const passwords = { password: { enabled: true, minLength: 12 } };

    await expect(build(passwords, false, { provider: 'smtp' }).service.get()).resolves.toMatchObject({
      passwordReset: true,
    });
    await expect(build(passwords, false, { provider: 'none' }).service.get()).resolves.toMatchObject({
      passwordReset: false,
    });
    await expect(build({}, false, { provider: 'smtp' }).service.get()).resolves.toMatchObject({
      passwordReset: false,
    });
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

  it('reports the password provider, and the minimum it enforces', async () => {
    const { service } = build({ password: { enabled: true, minLength: 20 } });

    await expect(service.get()).resolves.toMatchObject({ password: true, passwordMinLength: 20 });
  });

  it('reports passwords as unavailable by default — this is opt-in', async () => {
    await expect(build({}).service.get()).resolves.toMatchObject({ password: false });
  });

  it('never reports the token itself', async () => {
    const token = 'secret-bootstrap-token';
    const { service } = build({ bootstrapToken: token });

    expect(JSON.stringify(await service.get())).not.toContain(token);
  });
});
