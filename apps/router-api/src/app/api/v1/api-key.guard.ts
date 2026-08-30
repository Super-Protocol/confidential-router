import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiKeyService, type AuthenticatedApiKey, bearerTokenOf } from '../../api-keys/index.js';
import { openAiErrors } from './openai-error.js';

export interface ApiKeyRequest extends Request {
  apiKey?: AuthenticatedApiKey;
}

/**
 * `/v1` authentication: `Authorization: Bearer sk-tee-v1-…` and nothing else.
 *
 * Session cookies are deliberately not accepted — the console authenticates one
 * way and the gateway another (ADR-004 §6), and keeping the two guards apart is
 * what makes that a property rather than an intention. Failures come back in the
 * OpenAI error shape, which is why they are `OpenAiApiError` and not
 * `UnauthorizedException`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeyService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const secret = bearerTokenOf(request.headers.authorization);
    if (!secret) {
      throw openAiErrors.invalidApiKey();
    }

    const result = await this.apiKeys.authenticate(secret);
    if (!result.ok) {
      throw REJECTIONS[result.reason]();
    }

    request.apiKey = result.auth;
    // "Last used" means presented, not billed: a request refused for credit or
    // rate reasons is still evidence that the credential is live.
    await this.apiKeys.markUsed(result.auth.key.id);
    return true;
  }
}

const REJECTIONS = {
  invalid_api_key: openAiErrors.invalidApiKey,
  api_key_revoked: openAiErrors.apiKeyRevoked,
  api_key_expired: openAiErrors.apiKeyExpired,
} as const;

/** Reads what `ApiKeyGuard` resolved. Only meaningful behind that guard. */
export function apiKeyOf(request: ApiKeyRequest): AuthenticatedApiKey {
  if (!request.apiKey) {
    throw openAiErrors.invalidApiKey();
  }
  return request.apiKey;
}
