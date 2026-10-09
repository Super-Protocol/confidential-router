import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EVIDENCE_PRESENTATION } from '../evidence/evidence-state';
import { EXTERNAL_STATUS_PRESENTATION, EXTERNAL_VERDICT_LABELS } from './external-vocabulary';

/**
 * The two vocabularies, held apart.
 *
 * ADR-008 §1 makes this a rule rather than a style: *published / stale / not
 * published* is what the console may say about an endpoint the router never
 * verifies, and *verified by this router / denied by this router* is what it says
 * about one the router did. The failure mode is not a wrong colour — it is a
 * badge reading "Published" about a deployment this router verified, or
 * "Verified" about one it only watched, and either sentence is the product
 * claiming something it cannot back.
 *
 * So the assertions below are about *words*, and they are deliberately blunt: the
 * label sets must be disjoint, neither may borrow the other's vocabulary, and no
 * label may be a bare "verified" with no subject.
 */

const externalLabels = Object.values(EXTERNAL_STATUS_PRESENTATION).map((presentation) => presentation.label);
const ownLabels = Object.values(EVIDENCE_PRESENTATION).map((presentation) => presentation.label);

describe('the external vocabulary', () => {
  it('shares no label with the own-endpoint vocabulary', () => {
    expect(externalLabels.filter((label) => ownLabels.includes(label))).toEqual([]);
  });

  it('never says published, stale or not published', () => {
    for (const label of externalLabels) {
      expect(label.toLowerCase()).not.toMatch(/publish|stale/);
    }
  });

  it('names this router wherever it says verified or denied', () => {
    for (const label of externalLabels) {
      if (/verified|denied/i.test(label)) {
        expect(label).toContain('by this router');
      }
    }
  });

  it('has no bare “verified” anywhere, in a label or a headline', () => {
    for (const presentation of Object.values(EXTERNAL_STATUS_PRESENTATION)) {
      // "Verified by this router" is fine; "Verified" alone reads as a verdict
      // only the viewer's own gatekeeper may reach.
      expect(presentation.label).not.toBe('Verified');
      expect(presentation.headline).not.toBe('Verified');
    }
  });

  it('covers every status the schema can return', () => {
    expect(Object.keys(EXTERNAL_STATUS_PRESENTATION).sort()).toEqual([
      'DENIED_BY_THIS_ROUTER',
      'DISABLED',
      'PENDING',
      'VERIFIED_BY_THIS_ROUTER',
    ]);
  });

  it('says what a disabled upstream is, and what it is not', () => {
    // An operator's switch and a failed attestation are the two things this
    // state must never be confused between: one is a decision, the other a
    // verdict, and the remedy differs.
    expect(EXTERNAL_STATUS_PRESENTATION.DISABLED.note).toMatch(/switch rather than a verdict/i);
  });
});

describe('the own-endpoint vocabulary', () => {
  it('still never says verified, trusted or valid', () => {
    for (const presentation of Object.values(EVIDENCE_PRESENTATION)) {
      expect(`${presentation.label} ${presentation.headline}`.toLowerCase()).not.toMatch(/verified|trusted|valid/);
    }
  });
});

describe('the verified state', () => {
  it('is green — a pass reads as a pass, and the qualifier stays in the words (SUP-255)', () => {
    expect(EXTERNAL_STATUS_PRESENTATION.VERIFIED_BY_THIS_ROUTER.variant).toBe('success');
    expect(EXTERNAL_STATUS_PRESENTATION.DENIED_BY_THIS_ROUTER.variant).toBe('destructive');
    expect(EXTERNAL_STATUS_PRESENTATION.PENDING.variant).toBe('secondary');
  });
});

/**
 * And the separation as a property of the module graph, not of this file's prose.
 *
 * "The two vocabularies never mix in one component" is the acceptance criterion;
 * a component that imports both presentation maps is one `?:` away from breaking
 * it, whatever its current code does. The screens that render both kinds —
 * Models today — branch by origin and delegate to a component per vocabulary, so
 * neither map is in scope where the other one is.
 *
 * The scan is deliberately crude, like `chat/attestation/code-split.spec.ts`: it
 * reads source text and looks for the two identifiers. A false positive is a
 * one-line fix; a false negative is the defect this file exists to prevent.
 */
const COMPONENTS = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !/\.spec\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe('the module graph', () => {
  it('has no component holding both presentation maps', () => {
    const offenders = sourceFiles(COMPONENTS)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return source.includes('EXTERNAL_STATUS_PRESENTATION') && source.includes('EVIDENCE_PRESENTATION');
      })
      .map((file) => relative(COMPONENTS, file));

    expect(offenders).toEqual([]);
  });

  it('is not passing vacuously: both maps are referenced somewhere', () => {
    const sources = sourceFiles(COMPONENTS).map((file) => readFileSync(file, 'utf8'));

    expect(sources.some((source) => source.includes('externalStatusPresentation('))).toBe(true);
    expect(sources.some((source) => source.includes('evidencePresentation('))).toBe(true);
  });
});

/**
 * One spelling of the claim, across every surface that makes it.
 *
 * The admin section and the public catalogue describe the same verdict to
 * different audiences and legitimately differ in tone — `success` for an
 * operator who caused it, `warning` for a visitor being told it is a self-report
 * by the party they are already trusting. What they must not differ in is the
 * sentence itself. This repository has already paid once for two files that were
 * each supposed to be the single source of one thing (SUP-235), and the tripwire
 * then caught it after the merge rather than before.
 */
describe('the verdict labels', () => {
  it('are spelled in exactly one module', () => {
    const offenders = sourceFiles(COMPONENTS)
      .filter((file) => {
        if (file.endsWith(join('external', 'external-vocabulary.ts'))) return false;
        const source = readFileSync(file, 'utf8');
        return Object.values(EXTERNAL_VERDICT_LABELS).some((label) => source.includes(`'${label}'`));
      })
      .map((file) => relative(COMPONENTS, file));

    expect(offenders).toEqual([]);
  });

  it('are what the admin section\u2019s chips and timeline actually render', async () => {
    const { eventPresentation, statusPresentation } = await import('../admin/endpoint-status');

    expect(statusPresentation('VERIFIED_BY_THIS_ROUTER').label).toBe(EXTERNAL_VERDICT_LABELS.VERIFIED_BY_THIS_ROUTER);
    expect(statusPresentation('DENIED_BY_THIS_ROUTER').label).toBe(EXTERNAL_VERDICT_LABELS.DENIED_BY_THIS_ROUTER);
    expect(eventPresentation('VERIFIED_BY_THIS_ROUTER').label).toBe(EXTERNAL_VERDICT_LABELS.VERIFIED_BY_THIS_ROUTER);
    expect(eventPresentation('DENIED_BY_THIS_ROUTER').label).toBe(EXTERNAL_VERDICT_LABELS.DENIED_BY_THIS_ROUTER);
  });

  it('are what the public catalogue\u2019s badge renders', () => {
    expect(EXTERNAL_STATUS_PRESENTATION.VERIFIED_BY_THIS_ROUTER.label).toBe(
      EXTERNAL_VERDICT_LABELS.VERIFIED_BY_THIS_ROUTER,
    );
    expect(EXTERNAL_STATUS_PRESENTATION.DENIED_BY_THIS_ROUTER.label).toBe(
      EXTERNAL_VERDICT_LABELS.DENIED_BY_THIS_ROUTER,
    );
  });
});
