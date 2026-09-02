// Exercises the real client module against the real API with the gh CLI's token.
/**
 * Exercises the GitHub client against the real API. Read-only: it creates nothing, so it is
 * safe to run against a live account.
 *
 *   GH_TOKEN=$(gh auth token) npx tsx tests/github-client.test.mts
 */
import { setToken, currentUser, listProjects, projectTree, listDirectory, readJson, listProposals,
         listCollaborators, listPendingInvites, slugify, usernameFromEmail, lookupUser, resolvePerson } from '../src/renderer/src/github/client.js'

setToken(process.env.GH_TOKEN!)

async function main(): Promise<void> {

  const REPO = process.env.GH_TEST_REPO ?? 'DevDesai444/Aiper'
let bad = 0
  const check = (label: string, ok: boolean, detail: unknown): void => {
  console.log(`${ok ? '  ok ' : '  ✗  '} ${label}: ${JSON.stringify(detail)}`)
  if (!ok) bad++
}

  const me = await currentUser()
  // The login is the identity — access is repository collaborators, keyed by login. The email
  // is display only, needs the user:email scope, and must not be fatal when it is absent (the
  // gh CLI token used to run this locally does not carry that scope).
  check('currentUser resolves a login', me.login.length > 0, { login: me.login, hasEmail: !!me.email })

  const projects = await listProjects()
  check('listProjects (none tagged yet, must not throw)', Array.isArray(projects), { count: projects.length })

  const tree = await projectTree(REPO, 'main')
  check('projectTree', tree.entries.length > 10 && !tree.truncated, { entries: tree.entries.length })

  // A path that is committed on the default branch — the API reads the remote, not the
  // working tree, so anything added locally and not yet pushed would read as empty.
  const dir = await listDirectory(REPO, 'server/src')
  check('listDirectory', dir.some((e) => e.name === 'db.ts'), { files: dir.length })

  const missing = await listDirectory(REPO, 'no/such/folder')
  check('listDirectory on a missing path returns empty, not a throw', missing.length === 0, missing.length)

  const pkg = await readJson<{ name: string }>(REPO, 'package.json')
  check('readJson + base64 decode', pkg?.content.name === 'aiper', { name: pkg?.content.name, sha: pkg?.sha.slice(0, 7) })

  const absent = await readJson(REPO, 'does-not-exist.json')
  check('readJson on a missing file returns null', absent === null, absent)

  check('listProposals', Array.isArray(await listProposals(REPO, 'all')), 'array')
  const people = await listCollaborators(REPO)
  check('listCollaborators', people.some((p) => p.login === 'DevDesai444' && p.access === 'admin'), people.map((p) => `${p.login}:${p.access}`))
  check('listPendingInvites', Array.isArray(await listPendingInvites(REPO)), 'array')

  check('slugify', slugify('ANDA 217-445 — Rivastigmine TDS') === 'ANDA-217-445-Rivastigmine-TDS', slugify('ANDA 217-445 — Rivastigmine TDS'))
  check('slugify of punctuation only', slugify('///') === 'aiper-project', slugify('///'))

  // Any email's local part is split on `. _ -` and capitalised — no domain restriction.
  for (const [email, expected] of [
    ['dev.desai@aiper.com', 'DevDesai'],
    ['Dev.Desai@aiper.com', 'DevDesai'],
    ['riya.patel@aiper.com', 'RiyaPatel'],
    ['anna.van.dijk@aiper.com', 'AnnaVanDijk'],
    ['devdesai@aiper.com', 'Devdesai'],
    ['jane.doe@gmail.com', 'JaneDoe'],
    ['someone@outlook.com', 'Someone'],
    ['not-an-address', null],
    ['@no-local-part.com', null],
    ['no-domain@', null]
  ] as const) {
    check(`usernameFromEmail(${email})`, usernameFromEmail(email) === expected, usernameFromEmail(email))
  }

  check('lookupUser finds a real account', (await lookupUser('DevDesai444'))?.login === 'DevDesai444', 'DevDesai444')
  check('lookupUser returns null for a free username', (await lookupUser('aiper-no-such-user-9f3a2b')) === null, null)

  // A derived login that nobody holds must be refused, and must say what to do about it.
  const unclaimed = await resolvePerson('zz.unclaimed.test.person@gmail.com')
  check(
    'resolvePerson refuses an unclaimed derived login',
    !unclaimed.ok && unclaimed.expectedLogin === 'ZzUnclaimedTestPerson',
    unclaimed.ok ? 'resolved' : unclaimed.expectedLogin
  )

  const byLogin = await resolvePerson('DevDesai444')
  check('resolvePerson accepts a GitHub username directly',
    byLogin.ok && byLogin.user.login === 'DevDesai444' && byLogin.derivedFrom === 'login',
    byLogin.ok ? byLogin.user.login : byLogin.reason)

  console.log(bad === 0 ? '\nALL PASS' : `\n${bad} FAILED`)
  process.exit(bad === 0 ? 0 : 1)

}
void main()
