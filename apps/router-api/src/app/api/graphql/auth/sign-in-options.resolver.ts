import { Query, Resolver } from '@nestjs/graphql';
import { SignInOptionsService } from '../../../auth/index.js';
import { SignInOptionsModel } from './sign-in-options.model.js';

/**
 * What the sign-in screen may offer, for a viewer who by definition has no
 * session yet.
 *
 * Public, and with no guard at all rather than `OptionalSessionGuard`: there is
 * no per-viewer part of this answer to resolve. Everything it reports is
 * deployment configuration a caller could infer anyway by trying each path and
 * reading the error — this just lets the console skip the buttons that can only
 * fail.
 */
@Resolver(() => SignInOptionsModel)
export class SignInOptionsResolver {
  constructor(private readonly options: SignInOptionsService) {}

  @Query(() => SignInOptionsModel, {
    name: 'signInOptions',
    description: 'The sign-in paths this deployment offers. Public.',
  })
  async signInOptions(): Promise<SignInOptionsModel> {
    return this.options.get();
  }
}
