/**
 * Contract test: every check the pull-request gate runs is either run again on a push to `main`,
 * or declared here as a gap, with its reason.
 *
 * `nx affected` on a pull request diffs against `pull_request.base.sha` — the tip `main` had when
 * the PR was opened, not the tip it merges into. Two PRs can each be green on their own base and
 * merge into a tree neither of them ever checked; in SUP-483 that tree's typecheck was red for
 * three hours, with every gate green, because the incompatibility existed only in the merge.
 * `main.yml` exists to check the merged tree once the merge is a fact.
 *
 * The hazard with two workflows is that they drift. Someone adds a check to the PR gate, the
 * trunk gate keeps running the old set, and the trunk is unguarded again for exactly the thing
 * that was worth adding — and nothing in Actions notices, because both workflows stay green. That
 * is the same invisible gap the workflow under test exists to close, so it is closed the same way:
 * by making it fail something.
 *
 * The accounting is at job level, not at the level of Nx command lines. A job is what the PR gate
 * is built out of, and not every job is an Nx command — `demo` is two plain `nx run` calls and
 * `commitlint` is none at all, so a command-level check cannot see a job of either shape appear.
 * `PR_GATE_JOBS` below therefore has to name every job in `pull-request.yml`, which makes adding
 * one a decision about the trunk rather than a silent omission.
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

/** The composite action that owns the Go project the Nx commands exclude. */
const GO_CHECKS = './.github/actions/go-checks';

/**
 * Every job in `pull-request.yml`, and what the trunk gate does about it: the name of the
 * `main.yml` job that re-runs it, or the reason it is not re-run.
 *
 * A gap is allowed. An *undeclared* gap is the bug, so this map is checked for completeness
 * against the workflow itself — adding a job to the PR gate fails this spec until it is named.
 */
const PR_GATE_JOBS: Record<string, { mirroredAs: string } | { notMirrored: string }> = {
  // The PR title is the squash subject, so this lints the commit that will land. On a push the
  // commit has already landed and commitlint would be reporting on an unchangeable fact.
  commitlint: { notMirrored: 'it lints a PR title, and a trunk push has no PR' },
  nx: { mirroredAs: 'verify' },
  'router-api-postgres': { mirroredAs: 'postgres' },
  // The console suite installs a browser and a Go toolchain and is budgeted at twenty minutes,
  // against roughly five for everything in `main.yml`. The exposure that buys is real and
  // unclosed: two PRs whose merge breaks a Playwright flow, with nothing between the merge and the
  // next release that would notice. A standing decision on cost, not an oversight — revisit it the
  // first time a merge-only e2e failure reaches a release.
  e2e: { notMirrored: 'cost: a browser, a Go toolchain and a twenty-minute budget' },
  demo: { mirroredAs: 'demo' },
  // `release-router.yml` triggers on `push: [main]` and builds and pushes all three images, then
  // boots the compose stack from what it published. Mirroring this would build them twice.
  images: { notMirrored: 'release-router.yml already builds all three images on every push to main' },
  go: { mirroredAs: 'go' },
};

/** Jobs `main.yml` has that the PR gate does not, and why that is right. */
const TRUNK_ONLY: Record<string, string> = {
  // A pull request reports through its own checks UI, which someone is by definition looking at.
  // A trunk push has no such reader, which is the other half of what SUP-483 was about.
  report: 'a pull request reports through its checks UI; a trunk push has no reader',
};

/**
 * `nx run` invocations a mirrored PR-gate job makes that its trunk counterpart deliberately does
 * not. Declared rather than tolerated, so the difference stays a decision.
 */
const DROPPED_RUNS: Record<string, string[]> = {
  // The PR gate's schema-drift step builds router-api first because its `nx affected` can
  // legitimately run nothing and leave no `dist/` for those specs to resolve. `run-many` always
  // builds, so the trunk gate has no use for the preamble.
  nx: ['@confidential-router/router-api:build'],
};

/** `-t a b c` is greedy up to the next flag, which is how Nx itself reads it. */
const TARGETS = String.raw`(?:-t|--targets)\s+(.*?)(?=\s+-|\s*$)`;

interface Step {
  if?: string;
  uses?: string;
  run?: string;
}

interface Job {
  if?: string;
  needs?: string[];
  permissions?: Record<string, string>;
  steps?: Step[];
}

interface Workflow {
  // `on` is a plain key under YAML 1.2, which is what the `yaml` package parses; YAML 1.1 readers
  // would hand it over as the boolean `true` instead.
  on?: string | string[] | Record<string, { branches?: string[] }>;
  jobs?: Record<string, Job>;
}

function workflow(file: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as Workflow;
}

/** Step scripts with YAML line continuations folded, so a wrapped command reads as one line. */
function scripts(jobs: Job[]): string[] {
  return jobs
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run?.replace(/\\\s*\n/g, ' '))
    .filter((script): script is string => Boolean(script));
}

function uses(jobs: Job[]): (string | undefined)[] {
  return jobs.flatMap((job) => job.steps ?? []).map((step) => step.uses);
}

interface NxTargetRun {
  script: string;
  targets: string[];
  excluded: string[];
}

/** Every `nx <affected|run-many> -t …` in the given jobs, broken into the pieces that must agree. */
function nxTargetRuns(jobs: Job[], command: 'affected' | 'run-many'): NxTargetRun[] {
  const pattern = new RegExp(String.raw`\bnx\s+${command}\s+${TARGETS}`);
  return scripts(jobs).flatMap((script) => {
    const match = script.match(pattern);
    if (!match) return [];
    return [
      {
        script,
        targets: match[1].trim().split(/\s+/).sort(),
        excluded: [...script.matchAll(/--exclude[= ]([^\s\\]+)/g)].flatMap((exclude) => exclude[1].split(',')).sort(),
      },
    ];
  });
}

/** Every `nx run <project>:<target>`. `run-many` cannot match: it has no space before `-many`. */
function nxRuns(jobs: Job[]): string[] {
  return scripts(jobs)
    .flatMap((script) => [...script.matchAll(/\bnx\s+run\s+(\S+:\S+)/g)])
    .map((match) => match[1])
    .sort();
}

function only(runs: NxTargetRun[], what: string): NxTargetRun {
  expect(runs, `expected exactly one ${what}`).toHaveLength(1);
  return runs[0];
}

const pr = workflow('pull-request.yml');
const trunk = workflow('main.yml');

function job(wf: Workflow, key: string): Job {
  const found = wf.jobs?.[key];
  expect(found, `no job \`${key}\``).toBeDefined();
  return found as Job;
}

const MIRRORED = Object.entries(PR_GATE_JOBS).flatMap(([key, how]) =>
  'mirroredAs' in how ? [[key, how.mirroredAs] as const] : [],
);

/**
 * The trunk gate's reporting job, found by the one permission nothing else here needs rather than
 * by name, so renaming the job does not quietly turn these assertions off.
 */
function reporter(): [string, Job] {
  const found = Object.entries(trunk.jobs ?? {}).filter(([, spec]) => spec.permissions?.issues === 'write');
  expect(found, 'expected exactly one job allowed to write issues').toHaveLength(1);
  return found[0];
}

describe('the trunk gate mirrors the pull-request gate', () => {
  it('runs on a push to main, which is the event nothing used to check', () => {
    const on = trunk.on;
    expect(typeof on === 'object' && !Array.isArray(on) ? on.push?.branches : undefined).toContain('main');
  });

  it('accounts for every job in the pull-request gate', () => {
    // The completeness check, and the reason this map exists. A new PR-gate job lands here before
    // it can land anywhere, so "mirrored or declared" stays true by construction rather than by
    // someone having remembered.
    expect(Object.keys(PR_GATE_JOBS).sort()).toEqual(Object.keys(pr.jobs ?? {}).sort());
  });

  it('contains exactly the jobs it claims to, and nothing unaccounted for', () => {
    // The same completeness in the other direction: a job added to `main.yml` without being
    // declared is a check nobody can see the PR gate does not have, and — more to the point — one
    // the `report` job below is not required to report on.
    expect(Object.keys(trunk.jobs ?? {}).sort()).toEqual(
      [...MIRRORED.map(([, as]) => as), ...Object.keys(TRUNK_ONLY)].sort(),
    );
  });

  it('runs the same Nx invocations as each job it mirrors', () => {
    for (const [prKey, trunkKey] of MIRRORED) {
      const dropped = DROPPED_RUNS[prKey] ?? [];
      expect(nxRuns([job(trunk, trunkKey)]), `main.yml \`${trunkKey}\` vs ${prKey}`).toEqual(
        nxRuns([job(pr, prKey)])
          .filter((run) => !dropped.includes(run))
          .sort(),
      );
    }
    // Every declared drop has to be a drop. A stale entry here would silently widen what the next
    // one is allowed to omit.
    for (const [prKey, runs] of Object.entries(DROPPED_RUNS)) {
      expect(nxRuns([job(pr, prKey)]), `${prKey} no longer runs ${runs}`).toEqual(expect.arrayContaining(runs));
    }
  });

  it('runs the verify targets over the whole workspace, since a merge has no base to diff against', () => {
    const { script, targets } = only(
      nxTargetRuns([job(trunk, 'verify')], 'run-many'),
      '`nx run-many` command in the trunk gate',
    );
    expect(targets).toEqual(only(nxTargetRuns([job(pr, 'nx')], 'affected'), 'PR `nx affected`').targets);
    // Spelled out as well as compared, because the comparison is relative: it would be satisfied by
    // both gates dropping `typecheck`, which is the one thing SUP-483 asks for by name. Adding a
    // target to the gates means adding it here too — deliberately.
    expect(targets).toEqual(['build', 'lint', 'test', 'typecheck']);
    // `--base`/`--head` are what make a command relative to a diff. Neither has any meaning on a
    // trunk push, and `affected` against a guessed base is how SUP-483 happened.
    expect(script).not.toMatch(/--base|--head|nx\s+affected/);
  });

  it('excludes the same projects, each covered by the Go job both workflows run', () => {
    const trunkVerify = only(nxTargetRuns([job(trunk, 'verify')], 'run-many'), '`nx run-many`');
    expect(trunkVerify.excluded).toEqual(only(nxTargetRuns([job(pr, 'nx')], 'affected'), 'PR `nx affected`').excluded);
    // Exclusions are only safe while something else checks the excluded project. Today that is one
    // composite action, shared so the PR gate, the trunk gate and the release workflow cannot
    // disagree about what a green gatekeeper is.
    expect(trunkVerify.excluded).toEqual(['gatekeeper']);
    for (const [name, wf] of [
      ['pull-request.yml', pr],
      ['main.yml', trunk],
    ] as const) {
      expect(uses([job(wf, 'go')]), `${name} must run ${GO_CHECKS}`).toContain(GO_CHECKS);
    }
  });

  it('reports a failure somewhere a person looks, not only as a red tick', () => {
    // A failed run on the default branch mails whoever pressed Merge. This repo's PRs are merged by
    // agents, so that notification reaches nobody — the failure has to become an issue.
    const [, report] = reporter();

    // It has to survive the failure it reports on. A job left on the default `success()` would be
    // skipped by the very thing it exists to announce.
    expect(report.if).toMatch(/cancelled\(\)|always\(\)|failure\(\)/);
    const reporterScripts = scripts([report]).join('\n');
    expect(reporterScripts).toContain('gh issue create');
    // And clear the nag itself: a notice left up once it is stale is one people learn to scroll
    // past, which is how the next red main goes unseen.
    expect(reporterScripts).toContain('gh issue close');
  });

  it('raises the issue before it labels it, and never fails for want of a label', () => {
    // The label is a nicety; the issue is the whole point. `gh issue create --label` fails outright
    // on a label the repository does not have, and under `set -euo pipefail` so does creating one —
    // so with either ahead of the issue, a label problem becomes "no issue at all", which is the
    // failure this job exists to prevent rather than cause. Verified by simulation: with the two
    // reordered, a failing `gh label create` left the step red and nothing raised.
    const [, report] = reporter();
    const script = scripts([report]).join('\n');

    const raise = script.indexOf('gh issue create');
    const label = script.indexOf('gh label create');
    expect(raise, 'the reporter must create the issue').toBeGreaterThanOrEqual(0);
    expect(label, 'the reporter must ensure its label').toBeGreaterThanOrEqual(0);
    expect(raise, 'gh issue create has to come before gh label create').toBeLessThan(label);

    // And every label call stays best-effort, or `set -e` undoes the ordering above.
    for (const line of script.split('\n').filter((l) => /gh label create|--add-label/.test(l))) {
      expect(line.trim(), 'label calls must tolerate failure').toMatch(/\|\|\s*true$/);
    }
  });

  it('reports on every checking job, because it can only see what it needs', () => {
    const [, report] = reporter();
    // A job absent from `needs` cannot fail the reporter's `contains(needs.*.result, 'failure')`,
    // so it would run, go red, and raise nothing — a check that exists and reports nowhere, which
    // is worse than no check because it looks like cover. This is also why `go` stays here even
    // though `release-gatekeeper.yml` already runs it on every push to `main`.
    const [reporterKey] = reporter();
    expect(report.needs?.slice().sort()).toEqual(
      Object.keys(trunk.jobs ?? {})
        .filter((key) => key !== reporterKey)
        .sort(),
    );
  });
});
