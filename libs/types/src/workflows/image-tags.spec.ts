/**
 * Contract test: a commit-addressed image tag names one image, for good.
 *
 * `:main-<sha>` looks like it names a commit, and that is how it is used: a chart pins the digest the
 * tag resolved to, and "the tag still resolves to the declared digest" is the provenance check a
 * catalog PR body states and a reviewer re-runs. A container build is not reproducible byte-for-byte
 * — base layers, the SBOM and the provenance attestation differ per run — so a *second* publish of
 * the same commit hands out a different digest and that sentence quietly stops being true. In
 * SUP-316 the gatekeeper's nightly schedule did exactly that, because the job that pushes the image
 * was gated on `github.ref` alone and a scheduled run also carries `refs/heads/main`.
 *
 * So the rule is: only the push that advanced the ref may write the commit-addressed tag. Moving tags
 * (`:main`, `:latest`) and run-addressed ones (`:build<run number>`) are free to be rewritten or
 * minted — they promise nothing about a commit.
 *
 * The workflows are read from the repository root, like the other contract tests in this library:
 * nothing but a test holds a workflow to a rule, and the rule belongs to no single project.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const WORKFLOWS_DIR = join(here, '..', '..', '..', '..', '.github', 'workflows');

/** The `docker/metadata-action` tag type that encodes the commit, whatever prefix it is given. */
const COMMIT_TAG = 'type=sha';
/** The one expression that pins a job, a step or a tag to the push that advanced the ref. */
const PUSH_ONLY = "github.event_name == 'push'";

interface Step {
  if?: string;
  uses?: string;
  with?: Record<string, string>;
}

interface Job {
  if?: string;
  steps?: Step[];
}

interface Workflow {
  // `on` is a plain key under YAML 1.2, which is what the `yaml` package parses; YAML 1.1 readers
  // would hand it over as the boolean `true` instead.
  on?: string | string[] | Record<string, unknown>;
  jobs?: Record<string, Job>;
}

function triggers(workflow: Workflow): string[] {
  const on = workflow.on;
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on;
  return Object.keys(on ?? {});
}

/**
 * Every commit-addressed tag a workflow publishes, with everything that stands between it and a run:
 * the job's condition, the step's, and the `enable=` on the tag itself. Any one of them naming the
 * push event is enough.
 */
function commitTagPublishers(workflow: Workflow) {
  return Object.entries(workflow.jobs ?? {}).flatMap(([job, spec]) =>
    (spec.steps ?? [])
      .filter((step) => step.uses?.startsWith('docker/metadata-action'))
      .flatMap((step) =>
        (step.with?.tags ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.startsWith(COMMIT_TAG))
          .map((tag) => ({ job, tag, gate: `${spec.if ?? ''} ${step.if ?? ''} ${tag}` })),
      ),
  );
}

/**
 * Every release workflow, with the commit-addressed tags its jobs publish and — as a second opinion
 * on the parse — how many the file's text mentions. `type=sha` reached any other way, a `docker
 * build -t` in a `run` block, is outside what a static read of the tag list can see.
 */
const workflows = readdirSync(WORKFLOWS_DIR)
  .filter((file) => file.startsWith('release-') && file.endsWith('.yml'))
  .map((file) => {
    const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
    const workflow = parseYaml(text) as Workflow;
    return {
      file,
      mentions: text.split('\n').filter((line) => line.trim().startsWith(COMMIT_TAG)).length,
      publishers: commitTagPublishers(workflow),
      // A workflow that only ever runs on a push cannot publish the same commit twice by itself, so
      // it does not have to say so; one with a schedule or a dispatch beside it does.
      pushOnly: !triggers(workflow).some((trigger) => trigger !== 'push'),
    };
  });

const cases = workflows
  .filter(({ pushOnly }) => !pushOnly)
  .flatMap(({ file, publishers }) => publishers.map((publisher) => ({ file, ...publisher })));

describe('release workflows', () => {
  // A tag the parser missed — a renamed action, a tag list written as a sequence — would leave the
  // rule unpoliced while still reading as green.
  it.each(workflows)('$file: all $mentions of its commit-addressed tags were read', ({ mentions, publishers }) => {
    expect(publishers).toHaveLength(mentions);
  });

  it.each(cases)('$file: $job writes its commit-addressed tag only on a push', ({ tag, gate }) => {
    expect(gate, `nothing gates \`${tag}\` to a push event`).toContain(PUSH_ONLY);
  });
});
