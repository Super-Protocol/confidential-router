import type { ConfigType } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';
import type { routerConfig } from '../config.js';
import { SignInOptionsService } from './sign-in-options.service.js';

type RouterConfigType = ConfigType<typeof routerConfig>;

function build(auth: Partial<RouterConfigType['auth']>, hasUser = false) {
  const exists = vi.fn().mockResolvedValue(hasUser);
  const dataSource = { getRepository: () => ({ exists }) } as unknown as DataSource;
  const config = {
    auth: { magicLink: { mailer: 'console' }, ...auth },
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

  it('never reports the token itself', async () => {
    const token = 'secret-bootstrap-token';
    const { service } = build({ bootstrapToken: token });

    expect(JSON.stringify(await service.get())).not.toContain(token);
  });
});
