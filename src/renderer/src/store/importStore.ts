import { create } from 'zustand'
import { planImport, planProblems, runImport, type ImportPlan, type ImportProgress } from '../project/importProject'
import { useFolderStore } from './folderStore'
import { useToastStore } from '../common/toastStore'
import { useTreeStore } from './treeStore'

interface ImportState {
  /** Non-null while the confirmation dialog is up: what importing this folder would do. */
  plan: ImportPlan | null
  problems: string[]
  scanning: boolean
  progress: ImportProgress | null
  error: string | null

  /** Scan a folder and open the confirmation. Nothing is created until `confirm` runs. */
  begin: (rootPath: string) => Promise<void>
  confirm: (author: string) => Promise<void>
  cancel: () => void
}

export const useImportStore = create<ImportState>((set, get) => ({
  plan: null,
  problems: [],
  scanning: false,
  progress: null,
  error: null,

  begin: async (rootPath) => {
    set({ scanning: true, error: null, progress: null, plan: null, problems: [] })
    try {
      // The tree read doubles as the scan, and leaves treeStore holding what was found so the
      // dialog can show it rather than asking the user to trust a number.
      await useTreeStore.getState().openRoot(rootPath)
      const tree = useTreeStore.getState().root
      if (!tree) throw new Error('That folder could not be read.')
      const plan = await planImport(rootPath, tree)
      set({ plan, problems: planProblems(plan), scanning: false })
    } catch (err) {
      set({
        scanning: false,
        error: err instanceof Error ? err.message : 'That folder could not be read.'
      })
    }
  },

  confirm: async (author) => {
    let plan = get().plan
    if (!plan) return

    // Retrying after a failure has to re-plan, not reuse the old one: the failed attempt may
    // have left an empty workspace behind, and the fresh plan is what spots it and continues
    // into it instead of trying to create the same name a second time.
    if (get().error) {
      await get().begin(plan.rootPath)
      plan = get().plan
      if (!plan) return
    }

    set({ progress: { phase: 'scanning', message: 'Starting' }, error: null })
    try {
      let skipped: string[] = []
      let imported = plan.files.length
      const project = await runImport(plan, author, (p) => {
        if (p.phase === 'done') {
          skipped = p.skipped
          imported = p.fileCount
        }
        set({ progress: p })
      })
      // The project only exists to the rest of the app once the folder list has been refetched.
      await useFolderStore.getState().refresh()
      useFolderStore.getState().selectFolder(project.fullName, project.name)

      const toast = useToastStore.getState().push
      if (plan.target.mode === 'adopt') {
        toast(`Connected to “${project.name}” — it was already shared, so nothing was copied.`)
      } else if (skipped.length) {
        // Named, not counted: "3 files were skipped" leaves the reviewer to work out which
        // three are missing from a submission, which is exactly the wrong thing to make them do.
        toast(
          `Imported “${project.name}” — ${imported} files. These were too large and were left out: ${skipped.join(', ')}`,
          'warn'
        )
      } else {
        toast(`Imported “${project.name}” — ${imported} files.`)
      }
      set({ plan: null, progress: null })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'The import could not be completed.',
        progress: null
      })
    }
  },

  cancel: () => set({ plan: null, progress: null, error: null, problems: [] })
}))
