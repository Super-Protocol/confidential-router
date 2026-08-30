import { type CustomScalar, Scalar } from '@nestjs/graphql';
import { Kind, type ValueNode } from 'graphql';

/**
 * Marker type for `@Field(() => JSONObject)`. GraphQL needs a value to hang the
 * scalar on and TypeScript's `Record<string, unknown>` is not one.
 */
export class JSONObject {}

/**
 * Pass-through JSON, for the one field that has to be opaque: the raw evidence
 * bundle. Everything the console renders from a bundle has a typed field beside
 * it; `bundle` exists so a user can export or diff exactly what the platform
 * published, byte for byte, and typing that document here would mean this schema
 * had an opinion about it.
 *
 * Declared with Nest's `@Scalar` rather than as a bare `GraphQLScalarType`
 * instance so the scalar is built by the same `graphql` module instance the
 * schema factory uses — a second copy (ESM under vitest, CJS under webpack)
 * fails the `instanceof` check inside the schema builder.
 */
@Scalar('JSON', () => JSONObject)
export class JsonScalar implements CustomScalar<unknown, unknown> {
  description = 'Arbitrary JSON, serialised as-is.';

  serialize(value: unknown): unknown {
    return value;
  }

  parseValue(value: unknown): unknown {
    return value;
  }

  parseLiteral(ast: ValueNode): unknown {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
      case Kind.FLOAT:
        return Number(ast.value);
      case Kind.OBJECT:
        return Object.fromEntries(ast.fields.map((field) => [field.name.value, this.parseLiteral(field.value)]));
      case Kind.LIST:
        return ast.values.map((value) => this.parseLiteral(value));
      case Kind.NULL:
        return null;
      default:
        return undefined;
    }
  }
}
