// Merge-queue bot: one pass over every open PR labelled `queue`.
//
// Rules:
// 1. A PR is in the queue only while it has the label AND `test` is green on its head.
//    Its position is the moment both became true (later of label time and test finish).
// 2. A red `test` or a conflict keeps the label: the PR waits for a fix (one comment
//    per commit) and rejoins at the back when `test` is green again.
// 3. The label can be added at any time; a PR whose test is still running is silent
//    until the test finishes.
// The first PR in the queue is merged when it is up to date with the base; if it is
// behind, the bot updates the branch (label `queue:active`) and waits for the new test.
// GitHub's branch rules still decide whether each merge is allowed: the bot has no bypass.

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const REPO = process.env.GITHUB_REPOSITORY
const TOKEN = process.env.GITHUB_TOKEN
const DRY_RUN = process.env.DRY_RUN === 'true'
const RUN_URL = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''

const LABEL = 'queue'
const ACTIVE = 'queue:active'
const CHECK = 'test'
const TEST_WORKFLOW = 'test.yml'
const STATUS = 'merge-queue'
const MAX_MERGES_PER_PASS = 10
const MISSING_TEST_GRACE_MS = 3 * 60 * 1000
const WRITE_ROLES = new Set(['admin', 'maintain', 'write'])

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const short = sha => sha.slice(0, 7)

async function gh (method, path, body) {
  const response = await fetch(API + path, {
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
    const error = new Error(`${method} ${path} -> ${response.status}: ${data?.message || ''}`)
    error.status = response.status
    throw error
  }
  return data
}

async function write (description, fn) {
  console.log(`${DRY_RUN ? '[dry-run] would ' : ''}${description}`)
  if (!DRY_RUN) return fn()
}

const comment = (number, body) => write(`comment on #${number}: ${body.split('\n')[0]}`,
  () => gh('POST', `/repos/${REPO}/issues/${number}/comments`, { body }))

const removeLabel = (number, name) => write(`remove "${name}" from #${number}`, async () => {
  try { await gh('DELETE', `/repos/${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`) } catch (error) { if (error.status !== 404) throw error }
})

const addLabel = (number, name) => write(`add "${name}" to #${number}`,
  () => gh('POST', `/repos/${REPO}/issues/${number}/labels`, { labels: [name] }))

async function lastStatus (sha) {
  const statuses = await gh('GET', `/repos/${REPO}/commits/${sha}/statuses?per_page=100`)
  return statuses.find(status => status.context === STATUS)
}

// Returns true when the status changed (used to comment once per commit and state).
async function setStatus (sha, state, description) {
  const text = description.slice(0, 140)
  const last = await lastStatus(sha)
  if (last?.state === state && last?.description === text) return false
  await write(`status ${short(sha)}: ${state} "${text}"`, () =>
    gh('POST', `/repos/${REPO}/statuses/${sha}`, { state, context: STATUS, description: text, ...(RUN_URL ? { target_url: RUN_URL } : {}) }))
  return true
}

// Latest `queue` label event: when and by whom.
async function labelEvent (number) {
  let found = null
  for (let page = 1; page <= 10; page++) {
    const events = await gh('GET', `/repos/${REPO}/issues/${number}/timeline?per_page=100&page=${page}`)
    for (const event of events) if (event.event === 'labeled' && event.label?.name === LABEL) found = event
    if (events.length < 100) break
  }
  return found
}

async function canWrite (login) {
  if (!login) return false
  try {
    const { permission, role_name: role } = await gh('GET', `/repos/${REPO}/collaborators/${encodeURIComponent(login)}/permission`)
    return WRITE_ROLES.has(role) || WRITE_ROLES.has(permission)
  } catch (error) {
    if (error.status === 404) return false
    throw error
  }
}

// `test` check on a commit: green | red | pending | missing, with its finish time.
async function testState (sha) {
  const { check_runs: runs } = await gh('GET', `/repos/${REPO}/commits/${sha}/check-runs?check_name=${CHECK}&filter=latest&per_page=100`)
  const run = runs.sort((a, b) => b.id - a.id)[0]
  if (!run) return { state: 'missing' }
  const base = { url: run.html_url, completedAt: run.completed_at }
  if (run.status !== 'completed') return { state: 'pending', ...base }
  if (run.conclusion === 'success') return { state: 'green', ...base }
  if (['failure', 'timed_out'].includes(run.conclusion)) return { state: 'red', ...base }
  // cancelled, action_required (run awaiting approval), skipped, stale: no usable result.
  return { state: 'missing', ...base }
}

// mergeable_state is computed lazily; poll briefly until GitHub has it.
async function freshPr (number) {
  let pr
  for (let attempt = 0; attempt < 6; attempt++) {
    pr = await gh('GET', `/repos/${REPO}/pulls/${number}`)
    if (pr.state !== 'open' || (pr.mergeable !== null && pr.mergeable_state !== 'unknown')) return pr
    await sleep(2000)
  }
  return pr
}

// Not mergeable for now: keep the label, comment once per commit, let the next PR go.
async function waitForFix (pr, reason, hint) {
  if (pr.labels.some(label => label.name === ACTIVE)) await removeLabel(pr.number, ACTIVE)
  const changed = await setStatus(pr.head.sha, 'failure', `Waiting for a fix: ${reason}`)
  if (changed) await comment(pr.number, `Merge queue: ${reason} on ${short(pr.head.sha)}. ${hint}\n\nThe PR keeps its \`${LABEL}\` label and rejoins the queue when \`${CHECK}\` is green again.`)
}

const testFailed = (pr, test) => waitForFix(pr, `\`${CHECK}\` failed`, `See ${test.url}.`)
const conflicted = pr => waitForFix(pr, `conflicts with \`${pr.base.ref}\``, `Merge \`${pr.base.ref}\` into the branch and resolve the conflict.`)

async function readQueue (base) {
  const issues = await gh('GET', `/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`)
  const queue = []
  for (const issue of issues.filter(item => item.pull_request)) {
    // The issues search lags behind merges and label removals: trust the PR itself.
    const pr = await gh('GET', `/repos/${REPO}/pulls/${issue.number}`)
    if (pr.state !== 'open' || !pr.labels.some(label => label.name === LABEL)) continue
    const event = await labelEvent(pr.number)
    if (pr.base.ref !== base || pr.head.repo?.full_name !== REPO || !(await canWrite(event?.actor?.login))) {
      const reason = pr.base.ref !== base
        ? `it targets \`${pr.base.ref}\`; the queue only merges into \`${base}\``
        : pr.head.repo?.full_name !== REPO ? 'PRs from forks are not supported' : `the label was added by \`${event?.actor?.login || 'unknown'}\`, who has no write access`
      await removeLabel(pr.number, LABEL)
      await removeLabel(pr.number, ACTIVE)
      await comment(pr.number, `Removed from the merge queue: ${reason}.`)
      continue
    }
    const active = pr.labels.some(label => label.name === ACTIVE)
    const test = await testState(pr.head.sha)
    if (test.state === 'red') { await testFailed(pr, test); continue }
    // A commit that conflicted only rejoins with a new commit (a re-run cannot fix it).
    const last = await lastStatus(pr.head.sha)
    if (last?.state === 'failure' && /conflicts|could not update/.test(last.description)) continue
    if (pr.draft || test.state !== 'green') {
      // Labelled but not eligible yet: silent, unless it is the PR being brought up to date.
      if (active) queue.push({ pr, test, active, since: '' })
      continue
    }
    const labeledAt = event?.created_at || issue.created_at
    const since = labeledAt > test.completedAt ? labeledAt : test.completedAt
    queue.push({ pr, test, active, since })
  }
  // The active PR keeps its turn; the rest go by the moment they became eligible.
  queue.sort((a, b) => (b.active - a.active) || a.since.localeCompare(b.since) || a.pr.number - b.pr.number)
  return queue
}

async function clearStaleActive () {
  const issues = await gh('GET', `/repos/${REPO}/issues?state=all&labels=${encodeURIComponent(ACTIVE)}&per_page=100`)
  for (const issue of issues) {
    if (issue.state !== 'open' || !issue.labels.some(label => label.name === LABEL)) await removeLabel(issue.number, ACTIVE)
  }
}

const dispatchTest = (ref, sha) => write(`dispatch ${TEST_WORKFLOW} on ${ref} (${short(sha)})`,
  () => gh('POST', `/repos/${REPO}/actions/workflows/${TEST_WORKFLOW}/dispatches`, { ref }))

// Pushes made with the built-in token start no usable pull_request run (they need approval
// in public repos), so the bot starts Test itself once the updated head exists.
async function testUpdatedBranch (pr) {
  let current = pr
  for (let attempt = 0; attempt < 15 && current.head.sha === pr.head.sha; attempt++) {
    await sleep(2000)
    current = await gh('GET', `/repos/${REPO}/pulls/${pr.number}`)
  }
  if (current.head.sha === pr.head.sha) { console.log(`#${pr.number}: head not updated yet; a later pass starts Test`); return }
  await dispatchTest(current.head.ref, current.head.sha)
  await setStatus(current.head.sha, 'pending', `Next to merge: updated with ${pr.base.ref}, testing again`)
}

// Head has no usable Test run (e.g. a dispatch was lost): start one, unless the commit is brand new.
async function ensureTestRuns (pr) {
  const { commit } = await gh('GET', `/repos/${REPO}/commits/${pr.head.sha}`)
  if (Date.now() - Date.parse(commit.committer.date) < MISSING_TEST_GRACE_MS) return
  await dispatchTest(pr.head.ref, pr.head.sha)
}

// Returns 'merged', 'waiting' (this PR holds the turn) or 'skip' (let the next PR go).
async function advance (entry) {
  const pr = await freshPr(entry.pr.number)
  const { number } = pr
  if (pr.state !== 'open') return 'skip'
  if (pr.draft) {
    await removeLabel(number, ACTIVE)
    return 'skip'
  }
  if (pr.mergeable_state === 'dirty' || pr.mergeable === false) { await conflicted(pr); return 'skip' }
  if (pr.mergeable_state === 'behind') {
    if (!entry.active) await addLabel(number, ACTIVE)
    try {
      await write(`update #${number} with ${pr.base.ref}`, () =>
        gh('PUT', `/repos/${REPO}/pulls/${number}/update-branch`, { expected_head_sha: pr.head.sha }))
    } catch (error) {
      // 422 also covers "head moved": only a stable refusal waits for the author.
      if (![403, 422].includes(error.status)) throw error
      const moved = (await gh('GET', `/repos/${REPO}/pulls/${number}`)).head.sha !== pr.head.sha
      if (moved) return 'waiting'
      await waitForFix(pr, `the bot could not update the branch with \`${pr.base.ref}\``, `GitHub said: ${error.message.replace(/^.*?: /, '')}. Merge \`${pr.base.ref}\` into the branch yourself.`)
      return 'skip'
    }
    if (!DRY_RUN) await testUpdatedBranch(pr)
    return 'waiting'
  }
  const test = await testState(pr.head.sha)
  if (test.state === 'red') { await testFailed(pr, test); return 'skip' }
  if (test.state === 'missing') { await ensureTestRuns(pr); return 'waiting' }
  if (test.state === 'pending') {
    await setStatus(pr.head.sha, 'pending', 'Next to merge: waiting for test')
    return 'waiting'
  }
  try {
    await write(`merge #${number} at ${short(pr.head.sha)}`, () =>
      gh('PUT', `/repos/${REPO}/pulls/${number}/merge`, { sha: pr.head.sha, merge_method: 'merge' }))
  } catch (error) {
    // 409: head moved; 405: GitHub's rules refused (e.g. base moved). The next pass re-evaluates.
    if (error.status === 405 || error.status === 409) {
      console.log(`#${number}: merge refused (${error.message}); retrying next pass`)
      await setStatus(pr.head.sha, 'pending', `Next to merge: GitHub refused the merge, retrying (${error.status})`)
      return 'waiting'
    }
    throw error
  }
  if (DRY_RUN) return 'waiting'
  await removeLabel(number, ACTIVE)
  await removeLabel(number, LABEL)
  await setStatus(pr.head.sha, 'success', `Merged into ${pr.base.ref}`)
  await comment(number, `Merged by the merge queue at ${short(pr.head.sha)} (\`${CHECK}\` green, up to date with \`${pr.base.ref}\`).`)
  return 'merged'
}

async function pass (base) {
  const queue = await readQueue(base)
  if (!queue.length) { console.log('Queue is empty'); return false }
  console.log('Queue:', queue.map((entry, index) => `${index + 1}. #${entry.pr.number}${entry.active ? ' (active)' : ''}`).join(', '))
  for (const [index, entry] of queue.entries()) {
    if (index > 0) await setStatus(entry.pr.head.sha, 'pending', `In queue #${index + 1}: waiting for its turn`)
  }
  for (const entry of queue) {
    const result = await advance(entry)
    if (result !== 'skip') return result === 'merged'
  }
  return false
}

async function main () {
  if (!REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required')
  const { default_branch: base } = await gh('GET', `/repos/${REPO}`)
  await clearStaleActive()
  // Merging one PR can make the next one ready in the same pass.
  for (let merges = 0; merges < MAX_MERGES_PER_PASS; merges++) {
    if (!(await pass(base))) break
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
