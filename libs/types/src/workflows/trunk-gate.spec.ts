/**
 * Contract test: whatever the pull-request gate checks with `nx affected`, a push to `main` either
 * checks over the whole workspace or declares as a known gap, here, where it can be reviewed.
 *
 * `nx affected` on a pull request diffs against `pull_request.base.sha` — the tip `main` had when
 * the PR was opened, not the tip it merges into. Two PRs can each be green on their own base and
 * merge into a tree neither of them ever checked; in SUP-483 that tree's typecheck was red for
 * three hours, with every gate green, because the incompatibility existed only in the merge.
 * `main.yml` exists to run the same targets over the whole workspace once the merge is a fact.
 *
 * The hazard with two workflows is that they drift: someone adds a target to the PR gate, the
 * trunk gate keeps checking the old set, and the trunk is unguarded again for exactly the thing
 * that was worth adding. Nothing in Actions notices — both workflows stay green. So every
 * diff-relative command in the PR gate has to be accounted for below, which makes adding one a
 * decision about the trunk rather than an omission.
 *
 * The workflows are read from the repository root, like the other contract tests in this library:
 * nothing but a test holds a workflow to a rule, and the rule belongs to no single project.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(here, '..', '..', '..', '..', '.github', 'workflows');

/** The composite action that owns the Go project every Nx command below excludes. */
const GO_CHECKS = './.github/actions/go-checks';

/**
 * Target sets the PR gate runs against its diff base and the trunk gate deliberately does not
 * re-run over the whole workspace.
 *
 * `e2e` is here on cost: the console suite installs a browser and a Go toolchain and is budgeted
 * at twenty minutes, against roughly five for everything in `main.yml` today. The exposure that
 * buys is real and unclosed — two PRs whose merge breaks a Playwright flow, with nothing between
 * the merge and the next release that would notice. It is a standing decision, not an oversight;
 * revisit it the first time a merge-only e2e failure reaches a release.
 */
const UNMIRRORED = [['e2e']];

interface Step {
  if?: string;
  uses?: string;
  run?: string;
}

interface Job {
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  // `on` is a plain key under YAML 1.2, which is what the `yaml` package parses; YAML 1.1 readers
  // would hand it over as the boolean `true` instead.
  on?: string | string[] | Record<string, { branches?: string[] }>;
  jobs?: Record<string, Job>;
}

/**
 * `-t a b c` is greedy up to the next flag, which is how Nx itself reads it. The boundary is
 * whitespace followed by a dash, not a dash, so a hyphenated target name (`lint-fix`, `e2e-secure`)
 * stays whole — reading one as `lint` would be a quiet false pass here.
 */
const TARGETS = String.raw`(?:-t|--targets)\s+(.*?)(?=\s+-|\s*$)`;

function workflow(file: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as Workflow;
}

function steps(wf: Workflow): Step[] {
  return Object.values(wf.jobs ?? {}).flatMap((job) => job.steps ?? []);
}

interface NxCommand {
  script: string;
  targets: string[];
  excluded: string[];
}

/** Every `nx <affected|run-many> -t …` in a workflow, broken into the pieces the gates must agree on. */
function nxCommands(wf: Workflow, command: 'affected' | 'run-many'): NxCommand[] {
  const pattern = new RegExp(String.raw`\bnx\s+${command}\s+${TARGETS}`);
  return steps(wf)
    .map((step) => step.run?.replace(/\\\s*\n/g, ' '))
    .flatMap((script) => {
      const match = script?.match(pattern);
      if (!script || !match) return [];
      return [
        {
          script,
          targets: match[1].trim().split(/\s+/).sort(),
          excluded: [...script.matchAll(/--exclude[= ]([^\s\\]+)/g)].flatMap((exclude) => exclude[1].split(',')).sort(),
        },
      ];
    });
}

function only(commands: NxCommand[], what: string): NxCommand {
  expect(commands, `expected exactly one ${what}`).toHaveLength(1);
  return commands[0];
}

describe('the trunk gate mirrors the pull-request gate', () => {
  const pr = workflow('pull-request.yml');
  const trunk = workflow('main.yml');

  it('runs on a push to main, which is the event nothing used to check', () => {
    const on = trunk.on;
    expect(typeof on === 'object' && !Array.isArray(on) ? on.push?.branches : undefined).toContain('main');
  });

  it('accounts for every diff-relative command the pull-request gate runs', () => {
    const trunkTargets = nxCommands(trunk, 'run-many').map((nx) => nx.targets);
    // Set equality in both directions. A PR-gate command missing from the trunk is the SUP-483
    // hole; a trunk command the PR gate does not run is the same hole pointing the other way,
    // since every PR would then discover it only after merging.
    expect(
      nxCommands(pr, 'affected')
        .map((nx) => nx.targets)
        .sort(),
    ).toEqual([...trunkTargets, ...UNMIRRORED].sort());
  });

  it('runs its targets over the whole workspace, because a merge has no base to diff against', () => {
    const { script, targets } = only(nxCommands(trunk, 'run-many'), '`nx run-many` command in the trunk gate');
    // Spelled out rather than compared, because the parity check above is relative: it would be
    // satisfied by both gates dropping `typecheck`, which is the one thing SUP-483 asks for by
    // name. Adding a target to the gates means adding it here too — deliberately.
    expect(targets).toEqual(['build', 'lint', 'test', 'typecheck']);
    // `--base`/`--head` are what make a command relative to a diff. Neither has any meaning on a
    // trunk push, and `affected` against a guessed base is how SUP-483 happened.
    expect(script).not.toMatch(/--base|--head|nx\s+affected/);
  });

  it('excludes the same projects, each covered by the Go job both workflows run', () => {
    const trunkVerify = only(nxCommands(trunk, 'run-many'), '`nx run-many` command');
    const prVerify = only(
      nxCommands(pr, 'affected').filter((nx) => nx.targets.includes('typecheck')),
      '`nx affected` command driving typecheck',
    );
    expect(trunkVerify.excluded).toEqual(prVerify.excluded);
    // Exclusions are only safe while something else checks the excluded project. Today that is
    // one composite action, shared so the PR gate, the trunk gate and the release workflow cannot
    // disagree about what a green gatekeeper is.
    expect(trunkVerify.excluded).toEqual(['gatekeeper']);
    for (const [name, wf] of [
      ['pull-request.yml', pr],
      ['main.yml', trunk],
    ] as const) {
      expect(
        steps(wf).map((step) => step.uses),
        `${name} must run ${GO_CHECKS}`,
      ).toContain(GO_CHECKS);
    }
  });

  it('reports a failure somewhere a person looks, not only as a red tick', () => {
    // A failed run on the default branch mails whoever pressed Merge. This repo's PRs are merged
    // by agents, so that notification reaches nobody — the failure has to become an issue. The
    // job that writes one is identified by needing `issues: write`, which nothing else here does.
    const reporter = Object.values(trunk.jobs ?? {}).filter((job) => job.permissions?.issues === 'write');
    expect(reporter, 'expected exactly one job allowed to write issues').toHaveLength(1);
    const [report] = reporter;

    // It has to survive the failure it reports on. A job left on the default `success()` would be
    // skipped by the very thing it exists to announce.
    expect(report.if).toMatch(/cancelled\(\)|always\(\)|failure\(\)/);
    expect(report.steps?.some((step) => step.run?.includes('gh issue create'))).toBe(true);
    // And clear the nag itself: a notice left up once it is stale is one people learn to scroll
    // past, which is how the next red main goes unseen.
    expect(report.steps?.some((step) => step.run?.includes('gh issue close'))).toBe(true);
  });
});
