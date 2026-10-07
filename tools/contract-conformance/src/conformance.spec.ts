import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type ContractBlock, checkConformance, extractContractBlocks } from './conformance.js';

const block = (sdl: string, line = 1): ContractBlock => ({ section: 'As shipped (test)', line, sdl });
const messages = (contract: string, schema: string): string[] =>
  checkConformance([block(contract)], schema).map((violation) => violation.message);

describe('extractContractBlocks', () => {
  it('takes only graphql blocks under an "As shipped" heading', () => {
    const markdown = [
      '# Title',
      '```graphql',
      'type DesignTarget { a: Int }',
      '```',
      '## Background',
      '```graphql',
      'type Background { a: Int }',
      '```',
      '## As shipped (SUP-1) — one',
      '```ts',
      'const notSdl = 1;',
      '```',
      '```graphql',
      'type Shipped { a: Int }',
      '```',
      '### Subsection keeps the section',
      '```graphql',
      'type AlsoShipped { a: Int }',
      '```',
    ].join('\n');

    expect(extractContractBlocks(markdown)).toEqual([
      { section: 'As shipped (SUP-1) — one', line: 14, sdl: 'type Shipped { a: Int }' },
      { section: 'As shipped (SUP-1) — one', line: 18, sdl: 'type AlsoShipped { a: Int }' },
    ]);
  });

  it('refuses an unterminated fence rather than reading to the end', () => {
    expect(() => extractContractBlocks('## As shipped\n```graphql\ntype A { a: Int }\n')).toThrow(/unterminated/);
  });
});

describe('checkConformance', () => {
  it('accepts a schema that carries more than the contract', () => {
    const contract = 'type A { a: Int!, b(first: Int): [String!]! } enum E { X } input I { x: String }';
    const schema = `
      """described"""
      type A { a: Int!, b(first: Int, after: String): [String!]!, extra: Boolean }
      type Unrelated { z: Int }
      enum E { X Y }
      input I { x: String, optional: Int, defaulted: Int! = 1 }
    `;
    expect(messages(contract, schema)).toEqual([]);
  });

  it('names a missing type, field, argument, enum value and union member', () => {
    const contract = `
      type Missing { a: Int }
      type A { gone: Int, f(arg: ID!): Int }
      enum E { X Y }
      union U = A | B
    `;
    const schema = 'type A { f: Int } enum E { X } union U = A type B { b: Int }';
    expect(messages(contract, schema)).toEqual([
      'type Missing is missing',
      'A.gone: Int is missing',
      'A.f(arg: ID!) is missing the argument',
      'enum E is missing value Y',
      'union U is missing member B',
    ]);
  });

  it('fails on a divergent scalar where no document-level validation would (ExternalModelInput.id)', () => {
    expect(messages('input ExternalModelInput { id: String! }', 'input ExternalModelInput { id: ID! }')).toEqual([
      'ExternalModelInput.id is `String!` in the contract and `ID!` in schema.graphql',
    ]);
  });

  it('compares nullability and list wrapping, in both directions', () => {
    const contract = 'type Model { endpoint: Endpoint, tags: [String!]!, ids(of: [ID!]): Int }';
    const schema = 'type Model { endpoint: Endpoint!, tags: [String], ids(of: [ID!]!): Int }';
    expect(messages(contract, schema)).toEqual([
      'Model.endpoint returns `Endpoint` in the contract and `Endpoint!` in schema.graphql',
      'Model.tags returns `[String!]!` in the contract and `[String]` in schema.graphql',
      'Model.ids(of:) is `[ID!]` in the contract and `[ID!]!` in schema.graphql',
    ]);
  });

  it('fails on a required argument or input field the contract does not name', () => {
    const contract = 'type Mutation { update(input: UpdateInput!): Boolean! } input UpdateInput { name: String }';
    const schema = `
      type Mutation { update(id: ID!, input: UpdateInput!, dryRun: Boolean! = false): Boolean! }
      input UpdateInput { id: ID!, name: String }
    `;
    expect(messages(contract, schema)).toEqual([
      'Mutation.update(id: ID!) is required in schema.graphql and absent from the contract',
      'UpdateInput.id: ID! is required in schema.graphql and absent from the contract',
    ]);
  });

  it('compares a default the contract states, and ignores one it leaves out', () => {
    const contract = 'type Query { a(limit: Int = 20): Int, b(limit: Int): Int }';
    const schema = 'type Query { a(limit: Int = 50): Int, b(limit: Int = 50): Int }';
    expect(messages(contract, schema)).toEqual([
      'Query.a(limit:) is `Int = 20` in the contract and `Int = 50` in schema.graphql',
    ]);
  });

  it('fails when the kind differs', () => {
    expect(messages('input Thing { a: Int }', 'type Thing { a: Int }')).toEqual([
      'Thing is `input` in the contract and `type` in schema.graphql',
    ]);
  });

  it('requires the interfaces the contract names', () => {
    expect(messages('type A implements Node { id: ID! }', 'type A { id: ID! } interface Node { id: ID! }')).toEqual([
      'A does not implement Node',
    ]);
  });

  it('merges a type spread over several blocks, extensions included', () => {
    const blocks = [
      block('type Query { a: Int }'),
      block('extend type Query { b: Int }'),
      block('type Query { c: Int }'),
    ];
    expect(checkConformance(blocks, 'type Query { a: Int, b: Int }').map((violation) => violation.message)).toEqual([
      'Query.c: Int is missing',
    ]);
  });

  it('reports the contract contradicting itself across blocks', () => {
    const blocks = [block('type Query { a: Int }'), block('type Query { a: Int! }')];
    expect(checkConformance(blocks, 'type Query { a: Int! }').map((violation) => violation.message)).toContain(
      'Query.a: Int is also declared as Query.a: Int!',
    );
  });

  it('points at the contract line, offset by where the block starts', () => {
    const [violation] = checkConformance([block('type A {\n  a: Int\n  b: Int\n}', 40)], 'type A { a: Int }');
    expect(violation).toMatchObject({ signature: 'A.b', line: 42 });
  });

  it('reports a syntax error at its document line', () => {
    // graphql-js puts the location in the printed error, which is what main.ts prints.
    const parse = () => checkConformance([block('type A {\n  a: <\n}', 40)], 'type A { a: Int }');
    expect(parse).toThrow(/Unexpected character/);
    expect(() => {
      try {
        parse();
      } catch (error) {
        throw new Error(String(error));
      }
    }).toThrow('contract block (As shipped (test)):41:6');
  });
});

describe('the committed schema', () => {
  // The CI step runs `main.ts`; this is the same assertion inside the test target,
  // so `nx affected` catches a contract edit locally too.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  it('satisfies docs/contracts/console-graphql.md', () => {
    const blocks = extractContractBlocks(readFileSync(join(root, 'docs/contracts/console-graphql.md'), 'utf8'));
    expect(blocks.length).toBeGreaterThan(0);
    expect(checkConformance(blocks, readFileSync(join(root, 'apps/router-api/schema.graphql'), 'utf8'))).toEqual([]);
  });
});
