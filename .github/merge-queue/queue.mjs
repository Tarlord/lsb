// Merge-queue bot: one pass over every open PR labelled `queue`.
// Order: when the label was added. A PR is merged when its `test` check is
// green on a head that is up to date with the base; when it is behind, the bot
// updates the branch, re-runs Test and waits. GitHub's branch rules still decide
// whether each merge is allowed: the bot has no bypass.

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const REPO = process.env.GITHUB_REPOSITORY
const TOKEN = process.env.GITHUB_TOKEN
const DRY_RUN = process.env.DRY_RUN === 'true'
const RUN_URL = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${REPO}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''

const LABEL = 'queue'
const ACTIVE = 'queue:active' // the one PR the bot is bringing up to date
const CHECK = 'test'
const TEST_WORKFLOW = 'test.yml'
const STATUS = 'merge-queue'
const MAX_MERGES_PER_PASS = 10
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

async function setStatus (sha, state, description) {
  const statuses = await gh('GET', `/repos/${REPO}/commits/${sha}/statuses?per_page=100`)
  const last = statuses.find(status => status.context === STATUS)
  if (last?.state === state && last?.description === description) return
  await write(`status ${short(sha)}: ${state} "${description}"`, () =>
    gh('POST', `/repos/${REPO}/statuses/${sha}`, { state, context: STATUS, description: description.slice(0, 140), ...(RUN_URL ? { target_url: RUN_URL } : {}) }))
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

// `test` check on a commit: green | red | pending | missing.
async function testState (sha) {
  const { check_runs: runs } = await gh('GET', `/repos/${REPO}/commits/${sha}/check-runs?check_name=${CHECK}&filter=latest&per_page=100`)
  const run = runs.sort((a, b) => b.id - a.id)[0]
  if (!run) return { state: 'missing' }
  if (run.status !== 'completed') return { state: 'pending', url: run.html_url }
  if (run.conclusion === 'success') return { state: 'green', url: run.html_url }
  if (run.conclusion === 'cancelled') return { state: 'missing', url: run.html_url }
  return { state: 'red', url: run.html_url, conclusion: run.conclusion }
}

// mergeable_state is computed lazily; poll briefly until GitHub has it.
async function freshPr (number) {
  let pr
  for (let attempt = 0; attempt < 6; attempt++) {
    pr = await gh('GET', `/repos/${REPO}/pulls/${number}`)
    if (pr.mergeable !== null && pr.mergeable_state !== 'unknown') return pr
    await sleep(2000)
  }
  return pr
}

async function dequeue (entry, reason) {
  const { number, head } = entry.pr
  await removeLabel(number, LABEL)
  await removeLabel(number, ACTIVE)
  await setStatus(head.sha, 'failure', `Removed from queue: ${reason}`)
  await comment(number, `Removed from the merge queue: ${reason}.\n\nFix it and add the \`${LABEL}\` label again.`)
}

async function readQueue (base) {
  const issues = await gh('GET', `/repos/${REPO}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`)
  const entries = []
  for (const issue of issues.filter(item => item.pull_request)) {
    const event = await labelEvent(issue.number)
    entries.push({
      pr: await gh('GET', `/repos/${REPO}/pulls/${issue.number}`),
      labeledAt: event?.created_at || issue.created_at,
      labeledBy: event?.actor?.login,
      active: issue.labels.some(label => label.name === ACTIVE)
    })
  }
  entries.sort((a, b) => a.labeledAt.localeCompare(b.labeledAt) || a.pr.number - b.pr.number)

  const queue = []
  for (const entry of entries) {
    const { pr } = entry
    let reason = null
    if (pr.base.ref !== base) reason = `it targets \`${pr.base.ref}\`, the queue only merges into \`${base}\``
    else if (pr.head.repo?.full_name !== REPO) reason = 'PRs from forks are not supported'
    else if (!(await canWrite(entry.labeledBy))) reason = `the label was added by \`${entry.labeledBy || 'unknown'}\`, who has no write access`
    if (reason) { await dequeue(entry, reason); continue }
    entry.test = await testState(pr.head.sha)
    if (entry.test.state === 'red') { await dequeue(entry, `\`${CHECK}\` failed on ${short(pr.head.sha)} (${entry.test.url})`); continue }
    queue.push(entry)
  }
  return queue
}

// A leftover `queue:active` on a PR that left the queue would block nothing, but clean it up.
async function clearStaleActive () {
  const issues = await gh('GET', `/repos/${REPO}/issues?state=all&labels=${encodeURIComponent(ACTIVE)}&per_page=100`)
  for (const issue of issues) {
    if (issue.state !== 'open' || !issue.labels.some(label => label.name === LABEL)) await removeLabel(issue.number, ACTIVE)
  }
}

async function dispatchTest (pr, previousSha) {
  // update-branch is asynchronous: wait until the new head exists before dispatching.
  let current = pr
  for (let attempt = 0; attempt < 15 && current.head.sha === previousSha; attempt++) {
    await sleep(2000)
    current = await gh('GET', `/repos/${REPO}/pulls/${pr.number}`)
  }
  if (current.head.sha === previousSha) { console.log(`#${pr.number}: head not updated yet; next pass dispatches Test`); return }
  await write(`dispatch ${TEST_WORKFLOW} on ${current.head.ref} (${short(current.head.sha)})`,
    () => gh('POST', `/repos/${REPO}/actions/workflows/${TEST_WORKFLOW}/dispatches`, { ref: current.head.ref }))
  await setStatus(current.head.sha, 'pending', 'Next to merge: testing on the updated branch')
}

// Returns true when the PR was merged.
async function advance (entry) {
  const pr = await freshPr(entry.pr.number)
  const { number } = pr
  if (pr.state !== 'open') return false
  if (pr.draft) {
    if (entry.active) await removeLabel(number, ACTIVE)
    await setStatus(pr.head.sha, 'pending', 'In queue: waiting for the PR to be ready for review')
    return false
  }
  if (pr.mergeable_state === 'dirty' || pr.mergeable === false) {
    await dequeue({ pr }, `it conflicts with \`${pr.base.ref}\``)
    return false
  }
  if (pr.mergeable_state === 'behind') {
    if (!entry.active) await addLabel(number, ACTIVE)
    await write(`update #${number} with ${pr.base.ref}`, () =>
      gh('PUT', `/repos/${REPO}/pulls/${number}/update-branch`, { expected_head_sha: pr.head.sha }))
    if (!DRY_RUN) await dispatchTest(pr, pr.head.sha)
    return false
  }
  const test = await testState(pr.head.sha)
  if (test.state === 'missing') {
    if (!entry.active) await addLabel(number, ACTIVE)
    await write(`dispatch ${TEST_WORKFLOW} on ${pr.head.ref} (${short(pr.head.sha)})`,
      () => gh('POST', `/repos/${REPO}/actions/workflows/${TEST_WORKFLOW}/dispatches`, { ref: pr.head.ref }))
    await setStatus(pr.head.sha, 'pending', 'Next to merge: testing')
    return false
  }
  if (test.state === 'pending') {
    await setStatus(pr.head.sha, 'pending', 'Next to merge: waiting for test')
    return false
  }
  if (test.state === 'red') {
    await dequeue({ pr }, `\`${CHECK}\` failed on ${short(pr.head.sha)} (${test.url})`)
    return false
  }
  try {
    await write(`merge #${number} at ${short(pr.head.sha)}`, () =>
      gh('PUT', `/repos/${REPO}/pulls/${number}/merge`, { sha: pr.head.sha, merge_method: 'merge' }))
  } catch (error) {
    // 409: head moved; 405: GitHub's rules refused (e.g. base moved). The next pass re-evaluates.
    if (error.status === 405 || error.status === 409) {
      console.log(`#${number}: merge refused (${error.message}); retrying next pass`)
      await setStatus(pr.head.sha, 'pending', `Next to merge: GitHub refused the merge, retrying (${error.status})`)
      return false
    }
    throw error
  }
  if (DRY_RUN) return false
  await removeLabel(number, ACTIVE)
  await removeLabel(number, LABEL)
  await setStatus(pr.head.sha, 'success', `Merged into ${pr.base.ref}`)
  await comment(number, `Merged by the merge queue at ${short(pr.head.sha)} (\`${CHECK}\` green, up to date with \`${pr.base.ref}\`).`)
  return true
}

async function pass (base) {
  const queue = await readQueue(base)
  if (!queue.length) { console.log('Queue is empty'); return false }
  console.log('Queue:', queue.map((entry, index) => `${index + 1}. #${entry.pr.number} ${entry.test.state}${entry.active ? ' (active)' : ''}`).join(', '))

  // The active PR keeps its turn until it merges or leaves; otherwise the first green one goes.
  const head = queue.find(entry => entry.active) || queue.find(entry => entry.test.state === 'green' && !entry.pr.draft)
  for (const [index, entry] of queue.entries()) {
    if (entry === head) continue
    const waiting = entry.pr.draft ? 'waiting for ready for review' : entry.test.state === 'green' ? 'waiting for its turn' : 'waiting for test'
    await setStatus(entry.pr.head.sha, 'pending', `In queue #${index + 1}: ${waiting}`)
  }
  if (!head) return false
  return advance(head)
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
