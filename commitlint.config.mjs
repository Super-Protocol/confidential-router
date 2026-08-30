/**
 * Conventional Commits, enforced in CI against the PR title — pull requests are
 * squash-merged, so that title is the commit subject that lands on `main`.
 *
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Scopes are free-form, but prefer the project directory name
    // (gatekeeper, router-api, router-ui, types, ci, deps).
    'scope-case': [2, 'always', 'kebab-case'],
    'subject-case': [2, 'never', ['pascal-case', 'upper-case']],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
  },
};
