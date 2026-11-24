# Merge-queue experiment

A label-driven merge queue built only from GitHub Actions and the built-in token.

- Add the `queue` label to a PR into `master` (needs write access). If `test` is still
  running, the PR waits in the queue; if `test` failed, the label is removed.
- PRs go in label order. The first one with a green `test` is next: when it is behind
  `master`, the bot updates the branch (label `queue:active`), runs Test again and merges
  when green. A conflict or a red `test` removes the PR with a comment.
- The `merge-queue` commit status shows each PR's position.
- `master` requires `test` green on an up-to-date branch; the bot has no bypass.

`Test` is fake: it sleeps 1–4 minutes and fails when a file named `FAIL` exists.
