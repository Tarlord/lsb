# Merge-queue experiment

A label-driven merge queue built only from GitHub Actions and the built-in token.

1. A PR is in the queue only while it has the `queue` label **and** `test` is green on its
   latest commit. Its position is the moment both became true.
2. A red `test` or a conflict keeps the label: the bot comments once and the PR waits for
   a fix, then rejoins at the back when `test` is green again.
3. The label can be added at any time, also while `test` is still running.

The first PR in the queue is merged when it is up to date with `master`. If it is behind,
the bot updates the branch (label `queue:active`), waits for the new `test`, then merges.
Removing the label is the only way to leave the queue. The `merge-queue` commit status
shows each queued PR's position.

A pass runs when the `queue` label is added or a Test run finishes (Test pings the bot),
plus a 15-minute safety net. `master` requires `test` green on an up-to-date branch; the bot
has no bypass.

`Test` is fake: it sleeps 1–4 minutes and fails when a file named `FAIL` exists.
