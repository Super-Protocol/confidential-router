import { Controller, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AdminGuard, SessionGuard } from '../../auth/index.js';
import { HealthResponseDto } from './health.dto.js';
import { HealthService } from './health.service.js';

/**
 * The health document where an operator can actually read it (SUP-479).
 *
 * `/health` is the kubelet's probe and stays off the chart's `ingress.paths` on
 * purpose, so on a published deployment nginx answers 404 for it — and a
 * published cluster space has no exec and no port-forward, so there is no second
 * way in. That made `mail` (SUP-269) and `analytics` (SUP-464) readable only
 * from inside the cluster: the two subsystems that fail silently were reported
 * where nobody could look. Publishing `/health` itself was the other option and
 * is the wrong one — the document carries the database's error text and the mail
 * provider, which is why it has never been on a public hostname.
 *
 * `/admin` is already routed by the Ingress, so this needs no chart version and
 * no new listing version: the same document, behind the operator's session and
 * `auth.adminEmails`, exactly as the other two `/admin` routes are.
 *
 * Always `200`, unlike `/health`: the status code there is what a probe reads,
 * and this is not one — an operator reads the body, and a monitor that found
 * this route must not be able to mistake it for a liveness check. `status:
 * 'error'` in the body is how the database being down reads here. In practice it
 * barely can: sessions live in that database, so `SessionGuard` refuses before
 * this handler runs, and `/health` on the kubelet remains the answer for a
 * deployment that cannot reach PostgreSQL at all.
 */
@ApiTags('admin')
@Controller('admin/health')
@UseGuards(SessionGuard, AdminGuard)
export class AdminHealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'The /health document, reachable from outside the cluster. Restricted to auth.adminEmails.',
  })
  @ApiOkResponse({ type: HealthResponseDto, description: 'Answers 200 even when `status` is `error`.' })
  @ApiUnauthorizedResponse({ description: 'No console session.' })
  @ApiForbiddenResponse({ description: 'The session is not an operator.' })
  async check(): Promise<HealthResponseDto> {
    return this.healthService.check();
  }
}
