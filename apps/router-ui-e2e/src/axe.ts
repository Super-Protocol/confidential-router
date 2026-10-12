import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

/**
 * The one axe audit every spec in this suite uses.
 *
 * `serious` and `critical` are the impacts Lighthouse weights heavily enough
 * that a single one drops a page of this size below 90 —
 * `accessibility.spec.ts` explains why asserting on axe directly is that score
 * plus the part a number cannot give: which rule failed, on which element.
 */
const BLOCKING_IMPACTS = new Set(['serious', 'critical']);

/** The WCAG levels the console is held to. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Total budget for `settleAnimations`, in ms. A cap, not a wait. */
const SETTLE_TIMEOUT = 5_000;

/** Cap on waiting for a frame, in case rAF is throttled in a headless run. */
const FRAME_TIMEOUT = 200;

export interface BlockingViolation {
  id: string;
  impact: string | null | undefined;
  help: string;
  nodes: string[];
}

/**
 * Waits out every transition and finite animation in flight.
 *
 * axe samples computed colour, so a control measured mid-transition is a real
 * contrast failure of a frame no user ever reads. The shared button carries
 * both `transition-all` and `disabled:opacity-50`, so flipping one from
 * disabled to enabled fades a brand background in from half opacity, and a
 * dialog fades and zooms in over 200ms with every colour inside it a blend with
 * the overlay. Every Playwright gate — `toBeVisible()`, `toBeEnabled()`, a
 * sibling node appearing — resolves inside those windows, so an audit has to
 * wait for the animation itself. A fast machine finishes it before axe arrives;
 * a loaded CI runner does not, which is the whole of SUP-296.
 *
 * Infinite animations are skipped rather than awaited: a `Loader2` spinner or an
 * `animate-pulse` skeleton never finishes, and neither paints text — every
 * spinner is `aria-hidden`, and every `<Skeleton />` in the tree is
 * self-closing. Give a skeleton children and that stops being true: pulsing
 * text would then be judged at whatever opacity the sample caught, and this skip
 * is where the blind spot would be.
 *
 * Returns once nothing is in flight, or when `timeout` is spent — a stuck
 * animation should fail as the contrast violation it is, not as a hang.
 */
export async function settleAnimations(page: Page, timeout = SETTLE_TIMEOUT): Promise<void> {
  const deadline = Date.now() + timeout;

  // A pass settles what it finds; the loop then re-looks, because finishing one
  // animation can start the next (a dialog's overlay, then its content).
  while (Date.now() < deadline) {
    const settled = await page.evaluate(
      async ([budget, frameTimeout]) => {
        const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        // Two frames, so a style change React has just committed has been
        // recalculated and its transitions exist before they are collected.
        await Promise.race([
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
          after(frameTimeout),
        ]);

        const running = document.getAnimations().filter((animation) => {
          // `pending` is an animation that has started but whose start time the
          // browser has not resolved yet — in flight, just not yet `running`.
          if (animation.playState !== 'running' && !animation.pending) return false;
          // A filled-forwards animation stays in this list once finished, and an
          // infinite one has an infinite `endTime`; neither is worth awaiting.
          return Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Number.POSITIVE_INFINITY));
        });
        if (running.length === 0) return true;

        // `finished` rejects when an animation is cancelled — a node removed
        // mid-fade is as settled as the audit needs it to be.
        await Promise.race([
          Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
          after(budget),
        ]);
        return false;
      },
      [Math.max(0, deadline - Date.now()), FRAME_TIMEOUT] as const,
    );
    if (settled) return;
  }
}

/**
 * The serious and critical axe violations on the page once it has settled.
 *
 * Returns objects rather than strings so a failed `toEqual([])` prints the rule,
 * its impact, its help text and the offending selectors.
 */
export async function blockingViolations(page: Page): Promise<BlockingViolation[]> {
  await settleAnimations(page);

  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();

  return results.violations
    .filter((violation) => BLOCKING_IMPACTS.has(violation.impact ?? ''))
    .map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    }));
}
