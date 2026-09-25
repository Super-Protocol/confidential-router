import { ApiProperty } from '@nestjs/swagger';

/**
 * What the webhook answers.
 *
 * Deliberately thin: the form provider is not a client of ours and reads nothing
 * but the status code. It exists so the endpoint is documented in Swagger and so
 * the e2e suite has a shape to assert against — which is how "a redelivery
 * grants once" is testable at all.
 */
export class FeedbackWebhookDto {
  @ApiProperty({
    enum: ['granted', 'replayed', 'ignored', 'refused'],
    description: 'What this delivery did. `replayed` means the submission had already been settled.',
  })
  outcome!: 'granted' | 'replayed' | 'ignored' | 'refused';

  @ApiProperty({ required: false, description: 'Why nothing was credited. Present only when `outcome` is `refused`.' })
  reason?: string;
}
