/**
 * Put one file into an existing project, at a chosen location.
 *
 * The same rule as a folder import: the file is committed exactly as it is, and a `.docx`
 * additionally gets its editable `.aidoc.json` projection beside it. Converting in place
 * would drop tracked changes and comments, and a PDF or spreadsheet has no editable form at
 * all — so the original is always what lands.
 *
 * One commit, both blobs, so a document and its projection can never be half-added.
 */
import * as gh from '../github/client'
import { DOC_SUFFIX, splitId, type StoredDocument } from '../api/githubApi'
import { useFolderStore } from '../store/folderStore'
import { useToastStore } from '../common/toastStore'

const MAX_FILE_BYTES = 100 * 1024 * 1024

const encodeJson = (value: unknown): string => gh.encodeBase64(JSON.stringify(value, null, 2))

export async function uploadOne(
  absPath: string,
  target: { id: string; name: string }
): Promise<void> {
  const toast = useToastStore.getState().push
  const fileName = absPath.split(/[\\/]/).pop() ?? 'document'
  const { repo, path: dir } = splitId(target.id)

  try {
    const base64 = await window.aiper.fs.readFileBase64(absPath)
    if ((base64.length * 3) / 4 > MAX_FILE_BYTES) {
      toast(`${fileName} is larger than GitHub's 100 MB file limit.`, 'error')
      return
    }

    const repoPath = dir ? `${dir}/${fileName}` : fileName
    const entries = [{ path: repoPath, sha: await gh.createBlob(repo, base64) }]

    if (/\.docx$/i.test(fileName)) {
      const title = fileName.replace(/\.docx$/i, '')
      try {
        const result = (await window.aiper.docx.read(absPath)) as {
          model: { content: unknown; pageSetup: unknown }
        }
        const doc: StoredDocument = {
          aiper: 1,
          title,
          revision: 1,
          content: result.model.content,
          pageSetup: result.model.pageSetup ?? null,
          header: null,
          footer: null,
          comments: [],
          updatedAt: new Date().toISOString(),
          updatedBy: 'import'
        }
        entries.push({
          path: repoPath.replace(/\.docx$/i, DOC_SUFFIX),
          sha: await gh.createBlob(repo, encodeJson(doc))
        })
      } catch {
        // Unreadable by the converter — the original still goes in, just without an editable
        // copy. Refusing the upload entirely would be a worse trade.
        toast(`${fileName} was uploaded, but Aiper could not open it for editing.`, 'warn')
      }
    }

    const project = await gh.findRepo(...(repo.split('/') as [string, string]))
    const branch = project?.defaultBranch ?? 'main'
    const head = await gh.headCommit(repo, branch)
    const tree = await gh.createTree(repo, entries, head?.tree)
    const commit = await gh.createCommit(repo, `Add ${fileName}`, tree, head ? [head.commit] : [])
    await gh.setBranchHead(repo, branch, commit, !head)

    await useFolderStore.getState().refresh()
    toast(`Added “${fileName}” to ${target.name}.`)
  } catch (err) {
    toast(err instanceof Error ? err.message : `Could not upload ${fileName}.`, 'error')
  }
}
