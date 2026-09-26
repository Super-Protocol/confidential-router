/** Longest name the column holds; the input type refuses anything longer. */
export const MAX_MODEL_NAME_LENGTH = 200;

/**
 * Hugging Face is the place people copy an id from, and they copy it three ways:
 * the bare `org/model`, the page URL, and the `hf.co` short link. All three name
 * the same model, so all three collapse to the same key.
 */
const HUGGING_FACE_PREFIX = /^(?:https?:\/\/)?(?:www\.)?(?:huggingface\.co|hf\.co)\//i;

/**
 * The key the admin aggregation groups on.
 *
 * Aggressive enough to merge the spellings of one model, and no further. It
 * lower-cases, collapses whitespace, strips a Hugging Face URL down to its
 * `org/model` id and drops surrounding punctuation — the differences that are
 * typing, not meaning.
 *
 * What it deliberately leaves alone is everything after the name: a quantisation
 * or revision suffix (`…-instruct-awq`, `…:4bit`) names a different artefact to
 * serve, and merging those would answer "how many people want this model" with a
 * number that hides which build they wanted.
 *
 * The result is never empty for a non-empty input: if normalisation would strip
 * everything, the trimmed original is kept, because a row that groups under ''
 * is a row the export cannot explain.
 */
export function normaliseModelName(raw: string): string {
  const trimmed = raw.trim();
  const normalised = trimmed
    // Zero-width characters survive a copy from a rendered page and are
    // invisible in the export, where they would split one model into two rows.
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    // Before the prefix, not after: a URL somebody pasted inside angle brackets
    // or quotes would otherwise keep its scheme and never merge with the bare id.
    .replace(/^[\s"'`<([]+|[\s"'`>)\].,;:/]+$/g, '')
    .replace(HUGGING_FACE_PREFIX, '')
    // The prefix may itself have uncovered a trailing slash: `hf.co/org/model/`.
    .replace(/\/+$/, '')
    .toLowerCase();

  return normalised === '' ? trimmed.toLowerCase() : normalised;
}
