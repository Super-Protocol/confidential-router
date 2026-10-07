import {
  type ConstValueNode,
  type DefinitionNode,
  type FieldDefinitionNode,
  type InputValueDefinitionNode,
  Kind,
  type NamedTypeNode,
  parse,
  print,
  Source,
  type TypeNode,
} from 'graphql';

/**
 * Does the shipped SDL satisfy the contract's SDL?
 *
 * The contract document is the single place a schema change is agreed; both
 * sides code against it. SUP-225 and SUP-226 each edited it in parallel and each
 * claimed conformance, and the drift surfaced after merge as eleven codegen
 * errors plus a twelfth (`ExternalModelInput.id: ID!` against a contract
 * `String!`) that no document-level validation can see. This walks the
 * contract's AST against the schema's, so the same drift fails a pull request.
 *
 * "Satisfies" is deliberately one-directional. Everything the contract names —
 * type, kind, field, argument, input field, enum value, union member,
 * implemented interface — has to exist in the schema with the same signature,
 * nullability and list wrapping included. The schema may carry more, with one
 * exception: a *required* argument or input field the contract does not name is
 * a divergence, because a client written to the contract would omit it and be
 * rejected. Descriptions and directives are prose and are not compared.
 */

export interface ContractBlock {
  /** The `## ` heading the block sits under. */
  section: string;
  /** 1-based line of the first SDL line (the one after the opening fence). */
  line: number;
  sdl: string;
}

export interface Violation {
  /** The signature the violation is about, as a reader would search for it. */
  signature: string;
  message: string;
  /** 1-based line in the contract document, when the contract side has one. */
  line?: number;
}

/**
 * Only blocks under an `## As shipped …` heading are a contract. The document
 * opens with the SUP-66 design target, which it says itself differs from the
 * committed schema on purpose ("where the two differ, the committed file
 * wins"); that block is history, and checking it verbatim would fail forever.
 */
const CONTRACT_SECTION = /^As shipped\b/;

export function extractContractBlocks(markdown: string): ContractBlock[] {
  const blocks: ContractBlock[] = [];
  const lines = markdown.split('\n');
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const heading = /^## (.+)$/.exec(lines[i]);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    if (!/^```graphql\s*$/.test(lines[i])) continue;
    const end = lines.findIndex((line, j) => j > i && /^```\s*$/.test(line));
    if (end === -1) throw new Error(`unterminated \`\`\`graphql fence at line ${i + 1}`);
    if (CONTRACT_SECTION.test(section)) {
      blocks.push({ section, line: i + 2, sdl: lines.slice(i + 1, end).join('\n') });
    }
    i = end;
  }
  return blocks;
}

type Kindname = 'type' | 'interface' | 'input' | 'enum' | 'union' | 'scalar';

interface Field {
  type: string;
  line?: number;
  args: Map<string, InputValue>;
}

interface InputValue {
  type: string;
  defaultValue?: string;
  line?: number;
}

interface TypeShape {
  kind: Kindname;
  line?: number;
  fields: Map<string, Field>;
  inputFields: Map<string, InputValue>;
  values: Set<string>;
  members: Set<string>;
  interfaces: Set<string>;
}

interface Collected {
  types: Map<string, TypeShape>;
  conflicts: Violation[];
}

function kindOf(node: DefinitionNode): Kindname | undefined {
  switch (node.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_EXTENSION:
      return 'type';
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_EXTENSION:
      return 'interface';
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return 'input';
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_EXTENSION:
      return 'enum';
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.UNION_TYPE_EXTENSION:
      return 'union';
    case Kind.SCALAR_TYPE_DEFINITION:
    case Kind.SCALAR_TYPE_EXTENSION:
      return 'scalar';
    default:
      return undefined;
  }
}

const typeString = (node: TypeNode): string => print(node);
const valueString = (node: ConstValueNode | undefined): string | undefined => (node ? print(node) : undefined);

function inputValue(node: InputValueDefinitionNode, lineOffset: number): InputValue {
  return {
    type: typeString(node.type),
    defaultValue: valueString(node.defaultValue),
    line: node.loc ? node.loc.startToken.line + lineOffset : undefined,
  };
}

function signatureOf(value: InputValue): string {
  return value.defaultValue === undefined ? value.type : `${value.type} = ${value.defaultValue}`;
}

/**
 * Folds every definition and extension of a name into one shape. A name may be
 * spread over several blocks (`type Query` is, once per section); a member that
 * appears twice with two signatures is the contract contradicting itself, and is
 * reported rather than silently resolved either way.
 */
function collect(sources: { sdl: string; lineOffset: number; name: string }[]): Collected {
  const types = new Map<string, TypeShape>();
  const conflicts: Violation[] = [];

  for (const { sdl, lineOffset, name: sourceName } of sources) {
    // The offset makes a syntax error point at the document line, not the block line.
    const document = parse(new Source(sdl, sourceName, { line: lineOffset + 1, column: 1 }));
    for (const node of document.definitions) {
      const kind = kindOf(node);
      if (!kind || !('name' in node) || !node.name) continue;
      const name = node.name.value;
      const line = node.loc ? node.loc.startToken.line + lineOffset : undefined;

      let shape = types.get(name);
      if (!shape) {
        shape = {
          kind,
          line,
          fields: new Map(),
          inputFields: new Map(),
          values: new Set(),
          members: new Set(),
          interfaces: new Set(),
        };
        types.set(name, shape);
      } else if (shape.kind !== kind) {
        conflicts.push({
          signature: name,
          line,
          message: `${name} is declared both as \`${shape.kind}\` and as \`${kind}\``,
        });
        continue;
      }

      if ('interfaces' in node && node.interfaces) {
        for (const iface of node.interfaces as readonly NamedTypeNode[]) shape.interfaces.add(iface.name.value);
      }
      if ('types' in node && node.types) {
        for (const member of node.types) shape.members.add(member.name.value);
      }
      if ('values' in node && node.values) {
        for (const value of node.values) shape.values.add(value.name.value);
      }
      if ('fields' in node && node.fields) {
        if (kind === 'input') {
          for (const field of node.fields as readonly InputValueDefinitionNode[]) {
            const next = inputValue(field, lineOffset);
            const prior = shape.inputFields.get(field.name.value);
            if (prior && signatureOf(prior) !== signatureOf(next)) {
              conflicts.push({
                signature: `${name}.${field.name.value}`,
                line: next.line,
                message: `${name}.${field.name.value} is declared as both \`${signatureOf(prior)}\` and \`${signatureOf(next)}\``,
              });
            }
            shape.inputFields.set(field.name.value, next);
          }
        } else {
          for (const field of node.fields as readonly FieldDefinitionNode[]) {
            const next: Field = {
              type: typeString(field.type),
              line: field.loc ? field.loc.startToken.line + lineOffset : undefined,
              args: new Map((field.arguments ?? []).map((arg) => [arg.name.value, inputValue(arg, lineOffset)])),
            };
            const prior = shape.fields.get(field.name.value);
            if (prior && fieldSignature(field.name.value, prior) !== fieldSignature(field.name.value, next)) {
              conflicts.push({
                signature: `${name}.${field.name.value}`,
                line: next.line,
                message: `${name}.${fieldSignature(field.name.value, prior)} is also declared as ${name}.${fieldSignature(field.name.value, next)}`,
              });
            }
            shape.fields.set(field.name.value, next);
          }
        }
      }
    }
  }
  return { types, conflicts };
}

function fieldSignature(name: string, field: Field): string {
  const args = [...field.args].map(([arg, value]) => `${arg}: ${signatureOf(value)}`);
  return `${name}${args.length ? `(${args.join(', ')})` : ''}: ${field.type}`;
}

/** Non-null with no default: a caller that leaves it out is rejected. */
const isRequired = (value: InputValue): boolean => value.type.endsWith('!') && value.defaultValue === undefined;

export function checkConformance(blocks: ContractBlock[], schemaSdl: string): Violation[] {
  // `line` is 1-based and so is the token line, hence the -1.
  const contract = collect(
    blocks.map((block) => ({ sdl: block.sdl, lineOffset: block.line - 1, name: `contract block (${block.section})` })),
  );
  const schema = collect([{ sdl: schemaSdl, lineOffset: 0, name: 'apps/router-api/schema.graphql' }]);
  const violations: Violation[] = [...contract.conflicts];

  for (const [name, wanted] of contract.types) {
    const shipped = schema.types.get(name);
    if (!shipped) {
      violations.push({ signature: name, line: wanted.line, message: `${wanted.kind} ${name} is missing` });
      continue;
    }
    if (shipped.kind !== wanted.kind) {
      violations.push({
        signature: name,
        line: wanted.line,
        message: `${name} is \`${wanted.kind}\` in the contract and \`${shipped.kind}\` in schema.graphql`,
      });
      continue;
    }

    for (const iface of wanted.interfaces) {
      if (!shipped.interfaces.has(iface)) {
        violations.push({
          signature: `${name} implements ${iface}`,
          line: wanted.line,
          message: `${name} does not implement ${iface}`,
        });
      }
    }
    for (const member of wanted.members) {
      if (!shipped.members.has(member)) {
        violations.push({
          signature: `${name} = ${member}`,
          line: wanted.line,
          message: `union ${name} is missing member ${member}`,
        });
      }
    }
    for (const value of wanted.values) {
      if (!shipped.values.has(value)) {
        violations.push({
          signature: `${name}.${value}`,
          line: wanted.line,
          message: `enum ${name} is missing value ${value}`,
        });
      }
    }

    for (const [fieldName, field] of wanted.inputFields) {
      const signature = `${name}.${fieldName}`;
      const actual = shipped.inputFields.get(fieldName);
      if (!actual) {
        violations.push({ signature, line: field.line, message: `${signature}: ${signatureOf(field)} is missing` });
      } else if (signatureOf(actual) !== signatureOf(field) && !defaultOnlyInSchema(field, actual)) {
        violations.push({
          signature,
          line: field.line,
          message: `${signature} is \`${signatureOf(field)}\` in the contract and \`${signatureOf(actual)}\` in schema.graphql`,
        });
      }
    }
    if (wanted.kind === 'input') {
      for (const [fieldName, actual] of shipped.inputFields) {
        if (!wanted.inputFields.has(fieldName) && isRequired(actual)) {
          violations.push({
            signature: `${name}.${fieldName}`,
            line: wanted.line,
            message: `${name}.${fieldName}: ${actual.type} is required in schema.graphql and absent from the contract`,
          });
        }
      }
    }

    for (const [fieldName, field] of wanted.fields) {
      const signature = `${name}.${fieldName}`;
      const actual = shipped.fields.get(fieldName);
      if (!actual) {
        violations.push({
          signature,
          line: field.line,
          message: `${name}.${fieldSignature(fieldName, field)} is missing`,
        });
        continue;
      }
      if (actual.type !== field.type) {
        violations.push({
          signature,
          line: field.line,
          message: `${signature} returns \`${field.type}\` in the contract and \`${actual.type}\` in schema.graphql`,
        });
      }
      for (const [argName, arg] of field.args) {
        const argSignature = `${signature}(${argName})`;
        const actualArg = actual.args.get(argName);
        if (!actualArg) {
          violations.push({
            signature: argSignature,
            line: arg.line,
            message: `${signature}(${argName}: ${signatureOf(arg)}) is missing the argument`,
          });
        } else if (signatureOf(actualArg) !== signatureOf(arg) && !defaultOnlyInSchema(arg, actualArg)) {
          violations.push({
            signature: argSignature,
            line: arg.line,
            message: `${signature}(${argName}:) is \`${signatureOf(arg)}\` in the contract and \`${signatureOf(actualArg)}\` in schema.graphql`,
          });
        }
      }
      for (const [argName, actualArg] of actual.args) {
        if (!field.args.has(argName) && isRequired(actualArg)) {
          violations.push({
            signature: `${signature}(${argName})`,
            line: field.line,
            message: `${signature}(${argName}: ${actualArg.type}) is required in schema.graphql and absent from the contract`,
          });
        }
      }
    }
  }
  return violations;
}

/**
 * The contract leaving a default unstated is not a divergence when the types
 * agree: a client that sends the value never sees the default, and one that
 * omits it can only do so because the schema made it optional.
 */
function defaultOnlyInSchema(wanted: InputValue, actual: InputValue): boolean {
  return wanted.defaultValue === undefined && wanted.type === actual.type;
}
