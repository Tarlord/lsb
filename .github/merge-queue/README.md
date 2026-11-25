# Merge-queue experiment (full plan)

GitHub-merge-queue behaviour built from GitHub Actions: the queue tests "master + PR" on a
temporary commit and fast-forwards `master` to exactly that commit when it is green.

## Rules

1. A PR is in the queue while it has the `queue` label **and** `test` is green on its latest
   commit. Its position is the moment both became true.
2. A red PR test, a conflict or a failed queue test keeps the label: the bot comments once
   and the PR waits for a fix (a new commit, or re-adding the label to retry).
3. The label can be added at any time, also while `test` is still running.

4. `queue:priority` works like `queue` (no need for both) and puts the PR ahead of every
   PR without it, once its `test` is green. Priority PRs keep their order among themselves.
   It does not interrupt the candidate already being tested.

Removing the queue labels is the only way to leave the queue. The `merge-queue` commit status on
the PR shows its position or state.

## Flow (one candidate at a time)

1. The bot merges `master` and the first PR server-side into commit M and publishes it as
   `mq/master/pr-<n>-<head sha>`. The release branch is not touched.
2. Test runs on that push (on lms: the full suite).
3. Green, and neither `master` nor the PR moved → `master` is fast-forwarded to M. GitHub
   marks the PR merged because its head is now in `master`. Red → the PR waits for a fix.
4. A new commit on the PR or a removed label drops the candidate (its run is cancelled).

## Workflows

- **Test**: PR validation, queue-candidate validation; pings the queue when it finishes.
- **Queue label check**: when the label is added after `test` finished, starts the queue.
- **Merge queue**: the bot. Runs only when started by the above, manually, or by a
  15-minute safety net.

## Enforcement (rulesets)

- `master-checks` (no bypass): `test` required on the pushed commit, no force push, no deletion.
- `master-queue-only` (bypass: the queue's deploy key): restrict updates, PRs required.
- `queue-branches` (bypass: the queue's deploy key): only the queue creates, updates or
  deletes `mq/**`.

The deploy key is an environment secret (`merge-queue`, deployable from `master` only),
so PR workflows cannot read it. On lms the queue GitHub App plays this role.

`Test` is fake: it sleeps 1–4 minutes and fails when a file named `FAIL` exists.
