import { Field, ObjectType } from '@nestjs/graphql';

/**
 * Relay-shaped page info, shared by every connection in this schema.
 *
 * Forward-only: the console's lists are infinite scrolls over append-only data,
 * and `hasPreviousPage` would be a field no screen reads.
 */
@ObjectType('PageInfo')
export class PageInfoModel {
  @Field(() => Boolean)
  hasNextPage!: boolean;

  @Field(() => String, { nullable: true, description: 'Cursor of the last edge, to pass as `after`.' })
  endCursor!: string | null;
}
