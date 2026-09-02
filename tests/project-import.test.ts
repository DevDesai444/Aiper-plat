/**
 * Importing a folder as a project.
 *
 * The rule worth protecting here is "never duplicate": a folder that is already a GitHub
 * repository must be adopted, not copied into a second one. That decision rests entirely on
 * reading the origin remote out of .git/config, so the parsing is what gets tested — a URL
 * spelling this does not recognise silently becomes a duplicate repository in someone's
 * account, which is not the kind of mistake that announces itself.
 *
 * The scan is tested for what it refuses to carry: git metadata, caches and OS clutter have
 * no business in a regulatory submission repo, and a nested .git would be a second history
 * buried inside the project.
 */
import { parseGitHubRemote } from '../src/main/services/fs/gitRemote'

const failures: string[] = []
const check = (label: string, ok: boolean, detail?: string): void => {
  console.log(`${ok ? '  ok ' : '  ✗  '} ${label}${detail ? `: ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const config = (url: string, section = 'remote "origin"'): string =>
  `[core]\n\trepositoryformatversion = 0\n[${section}]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`

console.log('\n=== Reading the GitHub origin (decides adopt vs create) ===')

for (const [label, url] of [
  ['https with .git', 'https://github.com/DevDesai444/deficiency-chatbot.git'],
  ['https without .git', 'https://github.com/DevDesai444/deficiency-chatbot'],
  ['https with a trailing slash', 'https://github.com/DevDesai444/deficiency-chatbot/'],
  ['ssh scp-style', 'git@github.com:DevDesai444/deficiency-chatbot.git'],
  ['ssh:// url', 'ssh://git@github.com/DevDesai444/deficiency-chatbot.git'],
  ['https with a token in the url', 'https://x-access-token@github.com/DevDesai444/deficiency-chatbot.git']
] as const) {
  const parsed = parseGitHubRemote(config(url))
  check(
    label,
    parsed?.owner === 'DevDesai444' && parsed?.repo === 'deficiency-chatbot',
    parsed ? `${parsed.owner}/${parsed.repo}` : 'null'
  )
}

check('a repo name containing a dot survives', parseGitHubRemote(config('https://github.com/acme/site.com.git'))?.repo === 'site.com')

console.log('\n=== When there is no GitHub origin, it must import rather than adopt ===')

check('no remote section at all', parseGitHubRemote('[core]\n\tbare = false\n') === null)
check('a non-GitHub host', parseGitHubRemote(config('https://gitlab.com/acme/thing.git')) === null)
check('an empty config', parseGitHubRemote('') === null)
check('a malformed url', parseGitHubRemote(config('not-a-url')) === null)

// A fork's upstream is not where this project lives; adopting it would push a user's
// submission into somebody else's repository.
check(
  'only origin counts, not upstream',
  parseGitHubRemote(config('https://github.com/other/upstream.git', 'remote "upstream"')) === null
)

{
  const both =
    '[remote "upstream"]\n\turl = https://github.com/other/upstream.git\n' +
    '[remote "origin"]\n\turl = https://github.com/mine/project.git\n'
  const parsed = parseGitHubRemote(both)
  check('origin wins when both are present', parsed?.owner === 'mine', parsed ? `${parsed.owner}/${parsed.repo}` : 'null')
}

console.log('\n=== What the scan carries into the project ===')

// planImport reaches for window.aiper and the GitHub client, so the scan is exercised
// through a stub: no network, no repository, no account touched.
;(globalThis as unknown as Record<string, unknown>).window = {
  aiper: { fs: { gitHubRemote: async (): Promise<null> => null } }
}

const { planImport, planProblems } = await import('../src/renderer/src/project/importProject')

const tree = {
  path: '/p',
  name: 'submission-2201',
  type: 'folder' as const,
  children: [
    { path: '/p/3.2.P.5.docx', name: '3.2.P.5.docx', type: 'docx' as const },
    { path: '/p/appendix.pdf', name: 'appendix.pdf', type: 'file' as const },
    {
      path: '/p/stability',
      name: 'stability',
      type: 'folder' as const,
      children: [{ path: '/p/stability/data.xlsx', name: 'data.xlsx', type: 'file' as const }]
    },
    {
      path: '/p/.git',
      name: '.git',
      type: 'folder' as const,
      children: [{ path: '/p/.git/config', name: 'config', type: 'file' as const }]
    },
    {
      path: '/p/node_modules',
      name: 'node_modules',
      type: 'folder' as const,
      children: [{ path: '/p/node_modules/x.js', name: 'x.js', type: 'file' as const }]
    }
  ]
}

const plan = await planImport('/p', tree)
const paths = plan.files.map((f) => f.path).sort()

check('a PDF is carried like any other file', paths.includes('appendix.pdf'))
check('a spreadsheet is carried too', paths.includes('stability/data.xlsx'))

check('every real file is carried', plan.files.length === 3, paths.join(', '))
check('nested structure is preserved, not flattened', paths.includes('stability/data.xlsx'))
check('git metadata is not copied into the new repo', !paths.some((p) => p.startsWith('.git')))
check('caches are left behind', !paths.some((p) => p.startsWith('node_modules')))
check('non-Word files are carried too', paths.includes('appendix.pdf'))
check('only .docx is marked for conversion', plan.files.filter((f) => f.isDocx).length === 1)
check('the project takes the folder name', plan.projectName === 'submission-2201', plan.projectName)
check('no remote means a new workspace', plan.target.mode === 'create', plan.target.mode)
check('a scannable folder has no problems', planProblems(plan).length === 0)

{
  const empty = await planImport('/p', { path: '/p', name: 'empty', type: 'folder' as const, children: [] })
  check('an empty folder is refused with a reason', planProblems(empty).length === 1, planProblems(empty)[0])
}

console.log('\n=== An empty repository answers 409, not 404 ===')

// This is the bug that made every single import fail: GitHub replies 409 "Git Repository is
// empty." to a ref lookup on a repo with no commits, and handling only 404 meant the very
// first thing done to a newly created project threw.
{
  const { headCommit, GitHubError, setToken } = await import('../src/renderer/src/github/client')
  const original = globalThis.fetch

  const respondWith = (status: number, message: string): void => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message }), {
        status,
        headers: { 'content-type': 'application/json' }
      })) as typeof fetch
  }

  setToken('test-token')
  try {
    respondWith(409, 'Git Repository is empty.')
    check('409 reads as "no commits yet", not an error', (await headCommit('me/proj', 'main')) === null)

    respondWith(404, 'Not Found')
    check('404 still reads as no commits', (await headCommit('me/proj', 'main')) === null)

    // Anything else is a genuine failure and must not be mistaken for an empty repository —
    // that would silently discard the existing history and commit over the top of it.
    respondWith(403, 'Forbidden')
    let raised: unknown = null
    await headCommit('me/proj', 'main').catch((e) => {
      raised = e
    })
    check('403 is still raised', raised instanceof GitHubError, raised ? String(raised) : 'nothing thrown')
  } finally {
    globalThis.fetch = original
    setToken(null)
  }
}

console.log('\n=== A new project must not carry a README ===')

// GitHub's auto_init writes a README.md to give the repository its first commit. A regulatory
// project never wanted that document, and once the navigator started listing non-Aiper files
// it appeared in the tree as though someone had authored it. Asserted against the source
// because the alternative is creating a real repository to find out.
{
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../src/renderer/src/github/client.ts', import.meta.url), 'utf8')
  check('no repository is created with auto_init', !/auto_init:\s*true/.test(client))
  check('the first commit is the project marker instead', client.includes('PROJECT_MARKER'))

  const api = readFileSync(new URL('../src/renderer/src/api/githubApi.ts', import.meta.url), 'utf8')
  check('and the marker is filtered out of the tree', api.includes('gh.PROJECT_MARKER'))
}

console.log(failures.length === 0 ? '\nALL PASS' : `\nFAILED: ${failures.join(', ')}`)
if (failures.length > 0) process.exit(1)
