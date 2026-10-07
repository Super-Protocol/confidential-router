/**
 * Fails when `apps/router-api/schema.graphql` does not satisfy the SDL in
 * `docs/contracts/console-graphql.md` (SUP-237).
 *
 *   node tools/contract-conformance/src/main.ts
 *
 * CI runs exactly this in the pull-request workflow. Under GitHub Actions each
 * violation is also emitted as an error annotation on the contract line.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkConformance, extractContractBlocks, type Violation } from './conformance.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CONTRACT = 'docs/contracts/console-graphql.md';
const SCHEMA = 'apps/router-api/schema.graphql';

const blocks = extractContractBlocks(readFileSync(join(REPO_ROOT, CONTRACT), 'utf8'));
if (blocks.length === 0) {
  console.error(`[contract-conformance] no \`\`\`graphql block under an "## As shipped" heading in ${CONTRACT}`);
  process.exit(1);
}

let violations: Violation[];
try {
  violations = checkConformance(blocks, readFileSync(join(REPO_ROOT, SCHEMA), 'utf8'));
} catch (error) {
  // A syntax error in either document; graphql-js prints it with the location.
  console.error(`[contract-conformance] ${error}`);
  process.exit(1);
}
if (violations.length === 0) {
  console.log(
    `[contract-conformance] ${SCHEMA} satisfies ${blocks.length} contract blocks in ${CONTRACT}: ${blocks.map((block) => block.section).join('; ')}`,
  );
  process.exit(0);
}

console.error(
  `[contract-conformance] ${SCHEMA} does not satisfy ${CONTRACT} — ${violations.length} divergent signature(s):\n`,
);
for (const violation of violations) {
  const where = violation.line ? `${CONTRACT}:${violation.line}` : CONTRACT;
  console.error(`  ✗ ${violation.message}\n      at ${where}`);
  if (process.env.GITHUB_ACTIONS) {
    const line = violation.line ? `,line=${violation.line}` : '';
    console.log(
      `::error file=${CONTRACT}${line},title=Contract conformance: ${violation.signature}::${violation.message}`,
    );
  }
}
console.error(
  `\nThe contract lands first and both sides follow it. Either fix the resolvers and regenerate ${SCHEMA}` +
    ' (`pnpm nx run @confidential-router/router-api:schema`), or change the contract in the same pull request.',
);
process.exit(1);
