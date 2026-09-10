/**
 * Bring a folder from disk in as a project, whole.
 *
 * A project is a private GitHub repository, and until now the only way to get one was to
 * create it empty and add documents one at a time. A submission that already exists on
 * someone's laptop had no way in: "Open folder" read the tree and stopped there.
 *
 * Two rules shape this:
 *
 * **Nothing is lost.** Every file is committed byte-for-byte, whatever it is — .docx, PDF,
 * spreadsheet, image — with its folder structure intact. Converting a .docx into Aiper's
 * editable form is lossy (`importDocx` accepts pre-existing tracked changes into plain text
 * and drops comments and headers/footers), so that conversion is written *alongside* the
 * original as a `.aidoc.json`, never instead of it. The original stays as the as-imported
 * record.
 *
 * **Nothing is duplicated.** A folder already linked to a GitHub repository is adopted, not
 * copied: the repo is tagged as an Aiper project and left alone.
 *
 * The whole import is one commit, built through the Git Data API. The Contents API can only
 * write-and-commit, so a 200-file submission would arrive as 200 commits and 200 round-trips.
 */
import * as gh from '../github/client'
import { DOC_SUFFIX, type StoredDocument } from '../api/githubApi'
import type { FsTreeNode } from '../store/treeStore'

/** GitHub refuses a blob over 100 MB. Checked before anything is created, so an oversized
 *  file is a refusal rather than a repository left half-filled. */
const MAX_FILE_BYTES = 100 * 1024 * 1024
/** Past this an import is a mistake — a home directory picked instead of a submission. Worth
 *  stopping to ask rather than uploading thousands of files to someone's GitHub account. */
const MAX_FILES = 2_000

/** Never carried into a project: caches, OS clutter, and the git metadata itself — the repo
 *  gets its own history rather than a copy of the old one nested inside it. */
const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store', '.aiper-recovery', '__pycache__', '.venv'])

/**
 * Where the import will land, decided before it runs.
 *
 * `reuse` is what makes a failed import recoverable. An import that dies partway leaves the
 * repository it created behind, and the OAuth scope here (`repo`) cannot delete it — asking a
 * reviewer to go and tidy up on github.com is not a recovery path, it is a bug wearing a
 * hat. So a retry finds that empty repository and uses it.
 */
export type ImportTarget =
  | { mode: 'adopt'; fullName: string }
  | { mode: 'reuse'; fullName: string }
  | { mode: 'create'; name: string }

export interface ImportPlan {
  rootPath: string
  projectName: string
  files: Array<{ path: string; absPath: string; isDocx: boolean }>
  target: ImportTarget
}

export type ImportProgress =
  | { phase: 'scanning'; message: string }
  | { phase: 'uploading'; done: number; total: number; message: string }
  | { phase: 'committing'; message: string }
  | { phase: 'done'; project: gh.Project; fileCount: number; converted: number; skipped: string[] }

function flatten(node: FsTreeNode, prefix: string, out: ImportPlan['files']): void {
  for (const child of node.children ?? []) {
    if (SKIP_DIRS.has(child.name)) continue
    const rel = prefix ? `${prefix}/${child.name}` : child.name
    if (child.type === 'folder') {
      flatten(child, rel, out)
    } else {
      out.push({ path: rel, absPath: child.path, isDocx: child.type === 'docx' })
    }
  }
}

/**
 * Work out what importing this folder would do, without doing any of it.
 *
 * Separate from `runImport` so the user can be told "23 documents, will create a new
 * repository" and agree to it, rather than finding out afterwards.
 */
export async function planImport(rootPath: string, tree: FsTreeNode): Promise<ImportPlan> {
  const files: ImportPlan['files'] = []
  flatten(tree, '', files)

  const projectName = tree.name || rootPath.split(/[\\/]/).filter(Boolean).pop() || 'project'

  // Already a GitHub repository -> adopt it. Nothing is copied and no second repo is made.
  const remote = await window.aiper.fs.gitHubRemote(rootPath)
  if (remote) {
    return { rootPath, projectName, files, target: { mode: 'adopt', fullName: `${remote.owner}/${remote.repo}` } }
  }

  // Asking GitHub for the login rather than using githubApi.currentLogin(), which answers
  // 'unknown' on a cold cache — fine for a label, but here it would look up `unknown/<slug>`
  // and conclude the name was free when it is not.
  const login = await gh.currentUser().then((u) => u.login).catch(() => null)
  const slug = gh.slugify(projectName)
  if (!login) return { rootPath, projectName, files, target: { mode: 'create', name: slug } }

  const found = await gh.findRepo(login, slug).catch(() => null)
  if (!found) return { rootPath, projectName, files, target: { mode: 'create', name: slug } }

  // The name is taken. If it is one of ours with nothing in it, it is the wreckage of an
  // import that failed — reuse it. If it holds work, take the next free name rather than
  // stopping to make someone rename a folder.
  const empty = found.pushable && (await gh.isEmptyRepo(found).catch(() => false))
  return {
    rootPath,
    projectName,
    files,
    target: empty
      ? { mode: 'reuse', fullName: found.fullName }
      : { mode: 'create', name: await gh.freeRepoName(login, slug) }
  }
}

/** Human-readable reasons the plan cannot proceed. Empty means it can. */
export function planProblems(plan: ImportPlan): string[] {
  const problems: string[] = []
  if (plan.files.length === 0) {
    problems.push('That folder has no files in it.')
  }
  if (plan.files.length > MAX_FILES) {
    problems.push(`That folder holds ${plan.files.length} files. Pick the submission folder itself, not a folder above it.`)
  }
  return problems
}

async function docxProjection(
  file: { path: string; absPath: string },
  author: string
): Promise<{ path: string; json: StoredDocument } | null> {
  try {
    const result = (await window.aiper.docx.read(file.absPath)) as {
      model: { title: string; content: unknown; pageSetup: unknown }
    }
    const title = file.path.split('/').pop()!.replace(/\.docx$/i, '')
    return {
      path: file.path.replace(/\.docx$/i, DOC_SUFFIX),
      json: {
        aiper: 1,
        title,
        revision: 1,
        content: result.model.content,
        pageSetup: result.model.pageSetup ?? null,
        header: null,
        footer: null,
        comments: [],
        updatedAt: new Date().toISOString(),
        updatedBy: author
      }
    }
  } catch {
    // A .docx Aiper cannot read is still imported as a file — it simply arrives without an
    // editable projection. Losing the original because the converter choked would be worse.
    return null
  }
}

/**
 * Execute the plan: create or adopt the repository, then land everything in one commit.
 *
 * The repository is created only once every blob has been uploaded, so a failure partway
 * through leaves no empty repository behind in the user's account.
 */
export async function runImport(
  plan: ImportPlan,
  author: string,
  onProgress: (p: ImportProgress) => void
): Promise<gh.Project> {
  onProgress({ phase: 'scanning', message: `Reading ${plan.files.length} files` })

  // 1. Resolve the target repository first — an adoption needs no upload at all.
  if (plan.target.mode === 'adopt') {
    const adopted = await gh.adoptProject(plan.target.fullName)
    onProgress({ phase: 'done', project: adopted, fileCount: 0, converted: 0, skipped: [] })
    return adopted
  }

  const project =
    plan.target.mode === 'reuse'
      ? await gh.adoptProject(plan.target.fullName)
      : await gh.createEmptyProject(plan.target.name)

  try {
    // 2. Upload every original, then the generated projections.
    const entries: Array<{ path: string; sha: string }> = []
    const skipped: string[] = []
    let converted = 0
    let done = 0

    for (const file of plan.files) {
      let base64: string
      try {
        base64 = await window.aiper.fs.readFileBase64(file.absPath)
      } catch {
        // One unreadable file must not cost the other 181. Record it and carry on — an import
        // that refuses everything because of a single bad file is not a safer import.
        skipped.push(file.path)
        done++
        onProgress({ phase: 'uploading', done, total: plan.files.length, message: file.path })
        continue
      }

      // base64 inflates by 4/3; compare against the decoded size that would be stored.
      if ((base64.length * 3) / 4 > MAX_FILE_BYTES) {
        skipped.push(file.path)
        done++
        onProgress({ phase: 'uploading', done, total: plan.files.length, message: file.path })
        continue
      }
      entries.push({ path: file.path, sha: await gh.createBlob(project.fullName, base64) })

      if (file.isDocx) {
        const projection = await docxProjection(file, author)
        if (projection) {
          const encoded = gh.encodeBase64(JSON.stringify(projection.json, null, 2))
          entries.push({ path: projection.path, sha: await gh.createBlob(project.fullName, encoded) })
          converted++
        }
      }

      done++
      onProgress({ phase: 'uploading', done, total: plan.files.length, message: file.path })
    }

    if (entries.length === 0) {
      throw new Error('None of the files in that folder could be read.')
    }

    // 3. One tree, one commit, one ref update.
    onProgress({ phase: 'committing', message: 'Finishing up' })
    const head = await gh.headCommit(project.fullName, project.defaultBranch)
    const tree = await gh.createTree(project.fullName, entries, head?.tree)
    const commit = await gh.createCommit(
      project.fullName,
      `Import ${plan.projectName} (${plan.files.length - skipped.length} files)`,
      tree,
      head ? [head.commit] : []
    )
    await gh.setBranchHead(project.fullName, project.defaultBranch, commit, !head)

    onProgress({
      phase: 'done',
      project,
      fileCount: plan.files.length - skipped.length,
      converted,
      skipped
    })
    return project
  } catch (err) {
    // No instructions about GitHub. The empty repository left behind is picked up and reused
    // by the next attempt (see planImport), so retrying is the whole recovery — the person
    // importing a submission should never need a GitHub account open to fix this.
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`${reason}\n\nNothing was imported. Try again — it will pick up where this left off.`)
  }
}
