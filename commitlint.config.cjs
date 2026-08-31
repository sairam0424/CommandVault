/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [2, 'always', ['core', 'cli', 'vscode', 'deps', 'ci']],
    'scope-empty': [1, 'never'],
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'chore', 'ci', 'build', 'revert'],
    ],
  },
  // Dependabot's auto-generated commits routinely fail two rules above for
  // reasons that have nothing to do with commit-message quality:
  //   - it uses a "deps-dev" scope, which isn't in our human scope-enum list
  //   - its release-note bodies (comparison tables, long compare-link URLs)
  //     regularly exceed body-max-line-length
  // Both are false positives against an already machine-structured,
  // conventional-commit header. We skip linting ONLY commits carrying
  // Dependabot's own "Signed-off-by: dependabot[bot]" trailer — a line no
  // human-authored commit would organically contain — so every rule above
  // (and everything inherited from config-conventional) still applies in
  // full to every human commit.
  ignores: [(commit) => /^Signed-off-by: dependabot\[bot\]/m.test(commit)],
};
