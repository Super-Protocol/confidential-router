/**
 * The end-to-end demo, as a command.
 *
 *   pnpm nx run gatekeeper:e2e                        # what CI runs
 *   pnpm exec tsx tools/demo/src/main.ts --verbose    # with the router's log
 *
 * It narrates each step and exits non-zero at the first one that does not hold,
 * so the same script is both the demo someone watches and the check CI runs.
 * `docs/quickstart.md` walks the same sequence by hand.
 */
import { runStory } from './story.js';

/** ANSI, but only when stdout is a terminal — CI logs keep the escape codes out. */
const style = process.stdout.isTTY
  ? { bold: '\u001b[1m', dim: '\u001b[2m', green: '\u001b[32m', red: '\u001b[31m', reset: '\u001b[0m' }
  : { bold: '', dim: '', green: '', red: '', reset: '' };

const verbose = process.argv.includes('--verbose');
const started = Date.now();
let step = 0;

function elapsed(): string {
  return `${style.dim}+${((Date.now() - started) / 1000).toFixed(1)}s${style.reset}`;
}

try {
  const result = await runStory({
    verbose,
    onStep: (title) => {
      step += 1;
      console.log(`\n${style.bold}${step}. ${title}${style.reset}  ${elapsed()}`);
    },
    onDetail: (detail) => {
      for (const line of detail.split('\n')) {
        console.log(`   ${line}`);
      }
    },
  });

  console.log(`\n${style.green}The demo held, end to end.${style.reset}  ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`   pinned      ${result.firstDigest}`);
  console.log(`   rotated to  ${result.rotatedDigest}`);
  console.log(`   refused     HTTP ${result.denial.status} — ${result.denial.stage}: ${result.denial.reason}`);
  console.log(`   metered     ${result.metered.count} generation(s)`);
} catch (error) {
  console.error(`\n${style.red}The demo failed at step ${step}.${style.reset}  ${elapsed()}`);
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
}
