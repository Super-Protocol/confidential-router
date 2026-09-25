import { ApiProperty } from '@nestjs/swagger';

/**
 * What `GET /v1/invites/:code` answers.
 *
 * `reason` is a single value — `unavailable` — for every code that cannot be
 * redeemed. The caller is anonymous and rate-limited, and a response that told
 * "expired" apart from "never existed" would be an oracle: it turns the endpoint
 * into a way to confirm that a guessed code is a real one, which is most of the
 * work of stealing a grant. Operators get the real reason from the CLI and the
 * admin query, where the caller is known.
 */
export class InviteLookupDto {
  @ApiProperty({ description: 'Whether this code can still be redeemed.' })
  valid!: boolean;

  @ApiProperty({
    required: false,
    description: 'Micro-USD the code grants, as an integer string. Present only when valid.',
  })
  grantMicros?: string;

  @ApiProperty({ required: false, description: 'Campaign tag. Present only when valid.' })
  campaign?: string;

  @ApiProperty({
    required: false,
    enum: ['unavailable'],
    description: 'One value for every unusable code, on purpose. Present only when invalid.',
  })
  reason?: 'unavailable';
}
