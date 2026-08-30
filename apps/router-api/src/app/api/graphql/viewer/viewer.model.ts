import { Field, ID, ObjectType } from '@nestjs/graphql';

@ObjectType({ description: 'A workspace the viewer belongs to.' })
export class WorkspaceModel {
  @Field(() => ID)
  id!: string;

  @Field()
  name!: string;

  @Field()
  slug!: string;

  @Field(() => String, { description: 'Owner or member.' })
  role!: string;

  @Field(() => String, {
    description: 'Credit balance in micro-USD, as a string so no precision is lost in JSON.',
  })
  balanceMicros!: string;
}

@ObjectType({ description: 'The signed-in console user.' })
export class ViewerModel {
  @Field(() => ID)
  id!: string;

  @Field()
  email!: string;

  @Field(() => String, { nullable: true })
  name!: string | null;

  @Field(() => String, { nullable: true })
  image!: string | null;

  @Field(() => [WorkspaceModel])
  workspaces!: WorkspaceModel[];
}
