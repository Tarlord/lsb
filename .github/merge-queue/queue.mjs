// Merge-queue bot (full plan): tests "master + PR" on a temporary commit and
// fast-forwards master to exactly that commit when it is green.
//
// Queue rules:
// 1. A PR is in the queue while it has the `queue` label AND `test` is green on its
//    latest commit. Its position is the moment both became true.
// 2. A red PR test, a conflict or a failed queue test keeps the label: the bot
//    comments once and the PR waits for a fix (a new commit, or re-adding the label).
// 3. The label can be added at any time, also while the PR test is running.
//
// One candidate at a time: the bot merges master and the first PR server-side into
// commit M, publishes it as mq/<base>/pr-<n>-<head sha> (Test runs on that push), and
// when `test` is green on M and nothing moved, pushes M to master. Only the bot's
// deploy key may update master and mq/** (rulesets); master still requires `test`
// green on the pushed commit, with no bypass for anyone.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const REPO = process.env.GITHUB_REPOSITORY
const TOKEN = process.env.GITHUB_TOKEN
const DEPLOY_KEY = process.env.MQ_DEPLOY_KEY
const DRY_RUN = process.env.DRY_RUN === 'true'
const RUN_URL = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''

const LABEL = 'queue'
const CHECK = 'test'
const TEST_WORKFLOW = 'test.yml'
const STATUS = 'merge-queue'
const MAX_MERGES_PER_PASS = 10
const MISSING_TEST_GRACE_MS = 3 * 60 * 1000
const WRITE_ROLES = new Set(['admin', 'maintain', 'write'])
// Statuses that keep a PR out until a new commit or a re-added label.
const NEEDS_FIX = /conflicts|queue test failed/

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const short = sha => sha.slice(0, 7)
const candidateRef = (base, number, headSha) => `mq/${base}/pr-${number}-${headSha}`
const scratchRef = number => `mq-tmp/pr-${number}`

// ---------- GitHub API ----------

async function gh (method, route, body) {
  const response = await fetch(API + route, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = { message: text } }
  if (!response.ok) {
    const error = new Error(`${method} ${route} -> ${response.status}: ${data?.message || ''}`)
    error.status = response.status
    throw error
  }
  return { status: response.status, data }
}
const get = async route => (await gh('GET', route)).data

async function write (description, fn) {
  console.log(`${DRY_RUN ? '[dry-run] would ' : ''}${description}`)
  if (!DRY_RUN) return fn()
}

const comment = (number, body) => write(`comment on #${number}: ${body.split('\n')[0]}`,
  () => gh('POST', `/repos/${REPO}/issues/${number}/comments`, { body }))

const removeLabel = (number, name) => write(`remove "${name}" from #${number}`, async () => {
  try { await gh('DELETE', `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`) } catch (error) { if (error.status !== 404) throw error }
})

async function lastStatus (sha) {
  const statuses = await get(`/repos/${REPO}/commits/${sha}/statuses?per_page=100`)
  return statuses.find(status => status.context === STATUS)
}

// Returns true when the status changed (used to comment once per commit and state).
async function setStatus (sha, state, description, url = RUN_URL) {
  const text = description.slice(0, 140)
  const last = await lastStatus(sha)
  if (last?.state === state && last?.description === text) return false
  await write(`status ${short(sha)}: ${state} "${text}"`, () =>
    gh('POST', `/repos/${REPO}/statuses/${sha}`, { state, context: STATUS, description: text, ...(url ? { target_url: url } : {}) }))
  return true
}

async function labelEvent (number) {
  let found = null
  for (let page = 1; page <= 10; page++) {
    const events = await get(`/repos/${REPO}/issues/${number}/timeline?per_page=100&page=${page}`)
    for (const event of events) if (event.event === 'labeled' && event.label?.name === LABEL) found = event
    if (events.length < 100) break
  }
  return found
}

async function canWrite (login) {
  if (!login) return false
  try {
    const { permission, role_name: role } = await get(`/repos/${REPO}/collaborators/${encodeURIComponent(login)}/permission`)
    return WRITE_ROLES.has(role) || WRITE_ROLES.has(permission)
  } catch (error) {
    if (error.status === 404) return false
    throw error
  }
}

// `test` check on a commit: green | red | pending | missing.
async function testState (sha) {
  const { check_runs: runs } = await get(`/repos/${REPO}/commits/${sha}/check-runs?check_name=${CHECK}&filter=latest&per_page=100`)
  const run = runs.sort((a, b) => b.id - a.id)[0]
  if (!run) return { state: 'missing' }
  const base = { url: run.html_url, completedAt: run.completed_at }
  if (run.status !== 'completed') return { state: 'pending', ...base }
  if (run.conclusion === 'success') return { state: 'green', ...base }
  if (['failure', 'timed_out'].includes(run.conclusion)) return { state: 'red', ...base }
  return { state: 'missing', ...base } // cancelled, action_required, skipped, stale
}

const branchSha = async branch => (await get(`/repos/${REPO}/git/ref/heads/${branch}`)).object.sha

// ---------- git, authenticated with the deploy key (the only identity rules let through) ----------
// On lms the queue GitHub App does the same through the refs API; a deploy key needs git.

let gitDir = null
let sshCommand = null

function git (...args) {
  try {
    return execFileSync('git', args, { cwd: gitDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_SSH_COMMAND: sshCommand } }).trim()
  } catch (error) {
    const message = `${error.stderr || ''}`.trim().split('\n').filter(line => !line.startsWith('Warning: Permanently added')).join(' | ')
    const wrapped = new Error(`git ${args[0]} failed: ${message}`)
    wrapped.stderr = message
    throw wrapped
  }
}

function setupGit () {
  if (gitDir) return
  if (!DEPLOY_KEY) throw new Error('MQ_DEPLOY_KEY is required')
  gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mq-'))
  const keyFile = path.join(gitDir, '.deploy-key')
  fs.writeFileSync(keyFile, DEPLOY_KEY.endsWith('\n') ? DEPLOY_KEY : `${DEPLOY_KEY}\n`, { mode: 0o600 })
  sshCommand = `ssh -i ${keyFile} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`
  git('init', '-q')
  git('remote', 'add', 'origin', `git@github.com:${REPO}.git`)
}

const pushSha = (sha, ref) => write(`push ${short(sha)} to ${ref}`, () => {
  setupGit()
  git('fetch', '-q', '--filter=blob:none', 'origin', sha)
  git('push', '-q', 'origin', `${sha}:refs/heads/${ref}`)
})

const deleteRef = ref => write(`delete ${ref}`, () => {
  setupGit()
  try { git('push', '-q', 'origin', `:refs/heads/${ref}`) } catch (error) { if (!/remote ref does not exist/.test(error.stderr)) throw error }
})

// ---------- queue ----------

async function waitForFix (pr, reason, hint) {
  const changed = await setStatus(pr.head.sha, 'failure', `Waiting for a fix: ${reason}`)
  if (changed) await comment(pr.number, `Merge queue: ${reason} on ${short(pr.head.sha)}. ${hint}\n\nThe PR keeps its \`${LABEL}\` label and rejoins the queue when this is fixed (a new commit with a green \`${CHECK}\`, or re-adding the label to retry).`)
}

async function readQueue (base) {
  const issues = await get(`/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`)
  const queue = []
  for (const issue of issues.filter(item => item.pull_request)) {
    // The issues search lags behind merges and label removals: trust the PR itself.
    const pr = await get(`/repos/${REPO}/pulls/${issue.number}`)
    if (pr.state !== 'open' || !pr.labels.some(label => label.name === LABEL)) continue
    const event = await labelEvent(pr.number)
    if (pr.base.ref !== base || pr.head.repo?.full_name !== REPO || !(await canWrite(event?.actor?.login))) {
      const reason = pr.base.ref !== base
        ? `it targets \`${pr.base.ref}\`; the queue only merges into \`${base}\``
        : pr.head.repo?.full_name !== REPO ? 'PRs from forks are not supported' : `the label was added by \`${event?.actor?.login || 'unknown'}\`, who has no write access`
      await removeLabel(pr.number, LABEL)
      await comment(pr.number, `Removed from the merge queue: ${reason}.`)
      continue
    }
    const labeledAt = event?.created_at || issue.created_at
    const last = await lastStatus(pr.head.sha)
    // Conflict or failed queue test on this commit: out until a new commit or a re-added label.
    if (last?.state === 'failure' && NEEDS_FIX.test(last.description) && last.created_at > labeledAt) continue
    const test = await testState(pr.head.sha)
    if (test.state === 'red') { await waitForFix(pr, `\`${CHECK}\` failed`, `See ${test.url}.`); continue }
    if (pr.draft || test.state !== 'green') continue // labelled, not eligible yet: silent
    const since = labeledAt > test.completedAt ? labeledAt : test.completedAt
    queue.push({ pr, since })
  }
  queue.sort((a, b) => a.since.localeCompare(b.since) || a.pr.number - b.pr.number)
  return queue
}

async function readCandidates (base) {
  const refs = await get(`/repos/${REPO}/git/matching-refs/heads/mq/${base}/`)
  const candidates = []
  for (const ref of refs) {
    const name = ref.ref.replace('refs/heads/', '')
    const match = /\/pr-(\d+)-([0-9a-f]{40})$/.exec(name)
    if (!match) { await deleteRef(name); continue }
    const commit = await get(`/repos/${REPO}/git/commits/${ref.object.sha}`)
    candidates.push({ ref: name, sha: ref.object.sha, number: Number(match[1]), headSha: match[2], parents: commit.parents.map(parent => parent.sha), createdAt: commit.committer.date })
  }
  return candidates
}

async function cancelRuns (ref) {
  const { workflow_runs: runs } = await get(`/repos/${REPO}/actions/runs?branch=${encodeURIComponent(ref)}&per_page=20`)
  for (const run of runs.filter(item => item.status !== 'completed')) {
    await write(`cancel run ${run.id} on ${ref}`, async () => {
      try { await gh('POST', `/repos/${REPO}/actions/runs/${run.id}/cancel`) } catch (error) { if (error.status !== 409) throw error }
    })
  }
}

async function dropCandidate (candidate, why) {
  console.log(`drop ${candidate.ref}: ${why}`)
  await cancelRuns(candidate.ref)
  await deleteRef(candidate.ref)
}

// Returns 'waiting' (candidate still testing), 'merged' or 'dropped'.
async function checkCandidate (candidate, base) {
  const pr = await get(`/repos/${REPO}/pulls/${candidate.number}`)
  const masterSha = await branchSha(base)
  const labelled = pr.labels.some(label => label.name === LABEL)
  if (pr.state !== 'open' || !labelled) { await dropCandidate(candidate, 'PR closed or label removed'); return 'dropped' }
  if (pr.head.sha !== candidate.headSha) {
    await dropCandidate(candidate, 'PR has a new commit')
    await comment(pr.number, `Merge queue: the PR got a new commit (${short(pr.head.sha)}) while ${short(candidate.headSha)} was being tested. It rejoins the queue when \`${CHECK}\` is green on the new commit.`)
    return 'dropped'
  }
  if (candidate.parents[0] !== masterSha || candidate.parents[1] !== candidate.headSha) {
    await dropCandidate(candidate, `${base} moved (${short(masterSha)}); rebuilding`)
    return 'dropped'
  }
  const test = await testState(candidate.sha)
  if (test.state === 'pending') {
    await setStatus(pr.head.sha, 'pending', `Testing in the queue: ${base} + this PR (${short(candidate.sha)})`, test.url)
    return 'waiting'
  }
  if (test.state === 'missing') {
    if (Date.now() - Date.parse(candidate.createdAt) > MISSING_TEST_GRACE_MS) {
      await write(`dispatch ${TEST_WORKFLOW} on ${candidate.ref}`, () =>
        gh('POST', `/repos/${REPO}/actions/workflows/${TEST_WORKFLOW}/dispatches`, { ref: candidate.ref }))
    }
    await setStatus(pr.head.sha, 'pending', `Testing in the queue: ${base} + this PR (${short(candidate.sha)})`)
    return 'waiting'
  }
  if (test.state === 'red') {
    await dropCandidate(candidate, 'queue test failed')
    await waitForFix(pr, `queue test failed (${base} + this PR)`, `See ${test.url}.`)
    return 'dropped'
  }
  // Green: master becomes exactly the tested commit (fast-forward; rules check `test` on it).
  try {
    await pushSha(candidate.sha, base)
  } catch (error) {
    console.log(`push to ${base} refused: ${error.message}`)
    await setStatus(pr.head.sha, 'pending', `Queue test green, but the push to ${base} was refused; retrying`)
    return 'waiting'
  }
  if (DRY_RUN) return 'waiting'
  await deleteRef(candidate.ref)
  let merged = false
  for (let attempt = 0; attempt < 10 && !merged; attempt++) {
    await sleep(2000)
    merged = (await get(`/repos/${REPO}/pulls/${pr.number}`)).merged
  }
  await removeLabel(pr.number, LABEL)
  await setStatus(pr.head.sha, 'success', `Merged: ${base} is now ${short(candidate.sha)}`)
  await comment(pr.number, merged
    ? `Merged by the merge queue: \`${base}\` was fast-forwarded to ${candidate.sha}, the commit that passed \`${CHECK}\`.`
    : `\`${base}\` was fast-forwarded to ${candidate.sha} (this PR merged with \`${base}\`, \`${CHECK}\` green), but GitHub has not marked the PR merged yet.`)
  return 'merged'
}

// Build "base + first PR" and publish it for testing. Returns true when a candidate started.
async function startCandidate (queue, base) {
  for (const [index, entry] of queue.entries()) {
    const pr = await get(`/repos/${REPO}/pulls/${entry.pr.number}`)
    if (pr.state !== 'open' || pr.head.sha !== entry.pr.head.sha) continue
    const masterSha = await branchSha(base)
    const scratch = scratchRef(pr.number)
    await write(`create ${scratch} at ${base} ${short(masterSha)}`, async () => {
      try { await gh('POST', `/repos/${REPO}/git/refs`, { ref: `refs/heads/${scratch}`, sha: masterSha }) } catch (error) {
        if (error.status !== 422) throw error
        await gh('PATCH', `/repos/${REPO}/git/refs/heads/${scratch}`, { sha: masterSha, force: true })
      }
    })
    if (DRY_RUN) return true
    let merge
    try {
      merge = await gh('POST', `/repos/${REPO}/merges`, { base: scratch, head: pr.head.sha, commit_message: `Merge pull request #${pr.number} from ${pr.head.repo.full_name.split('/')[0]}/${pr.head.ref}\n\n${pr.title}` })
    } catch (error) {
      await gh('DELETE', `/repos/${REPO}/git/refs/heads/${scratch}`).catch(() => {})
      if (error.status !== 409) throw error
      await waitForFix(pr, `conflicts with \`${base}\``, `Merge \`${base}\` into the branch and resolve the conflict.`)
      continue
    }
    if (merge.status === 204) { // nothing to merge: the PR is already in base
      await gh('DELETE', `/repos/${REPO}/git/refs/heads/${scratch}`).catch(() => {})
      continue
    }
    const ref = candidateRef(base, pr.number, pr.head.sha)
    await pushSha(merge.data.sha, ref)
    await gh('DELETE', `/repos/${REPO}/git/refs/heads/${scratch}`).catch(() => {})
    await setStatus(pr.head.sha, 'pending', `Testing in the queue: ${base} + this PR (${short(merge.data.sha)})`)
    for (const [position, other] of queue.entries()) {
      if (position > index) await setStatus(other.pr.head.sha, 'pending', `In queue #${position - index + 1}: waiting for its turn`)
    }
    return true
  }
  return false
}

async function pass (base) {
  const queue = await readQueue(base)
  const candidates = await readCandidates(base)
  console.log(`Queue: ${queue.map(entry => `#${entry.pr.number}`).join(', ') || 'empty'}; testing: ${candidates.map(c => `#${c.number} (${short(c.sha)})`).join(', ') || 'none'}`)
  // One candidate at a time; extra ones (from a crash) are dropped.
  for (const extra of candidates.slice(1)) await dropCandidate(extra, 'more than one candidate')
  const candidate = candidates[0]
  if (candidate) {
    const result = await checkCandidate(candidate, base)
    if (result === 'merged') return true
    if (result === 'waiting') {
      for (const [index, entry] of queue.filter(item => item.pr.number !== candidate.number).entries()) {
        await setStatus(entry.pr.head.sha, 'pending', `In queue #${index + 2}: waiting for its turn`)
      }
      return false
    }
    return pass(base) // dropped: start the next one in this pass
  }
  await startCandidate(queue, base)
  return false
}

async function main () {
  if (!REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
  const { default_branch: base } = await get(`/repos/${REPO}`)
  // Leftover scratch refs from an interrupted pass.
  for (const ref of await get(`/repos/${REPO}/git/matching-refs/heads/mq-tmp/`)) {
    await write(`delete ${ref.ref}`, () => gh('DELETE', `/repos/${REPO}/git/${ref.ref}`))
  }
  // Merging one PR lets the next candidate start in the same pass.
  for (let merges = 0; merges < MAX_MERGES_PER_PASS; merges++) {
    if (!(await pass(base))) break
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  if (gitDir) fs.rmSync(gitDir, { recursive: true, force: true })
})
