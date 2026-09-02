import { useUiStore } from '../store/uiStore'
import { useDocumentStore } from '../store/documentStore'
import { useComplianceStore } from '../store/complianceStore'
import { useToastStore, notImplemented } from '../common/toastStore'
import { askText } from '../common/promptStore'
import { RULEBOOK } from '../common/rulebook'

const toast = (msg: string, tone: 'info' | 'warn' | 'error' = 'info'): void =>
  useToastStore.getState().push(msg, tone)

/** Writes text to a file the user chooses, via the same save dialog the editor uses. */
async function saveTextFile(defaultName: string, contents: string): Promise<boolean> {
  if (!window.aiper) {
    // Browser-only fallback (dev server without the preload bridge).
    const blob = new Blob([contents], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = defaultName
    a.click()
    URL.revokeObjectURL(a.href)
    return true
  }
  const path = await window.aiper.fs.saveFileDialog(defaultName)
  if (!path) return false
  // docx.write expects a document model, so a plain report goes through the print bridge's
  // sibling: write it as a text document the same way the editor writes .docx bytes.
  const model = {
    title: defaultName,
    content: {
      type: 'doc',
      content: contents.split('\n').map((line) => ({
        type: 'paragraph',
        ...(line ? { content: [{ type: 'text', text: line }] } : {})
      }))
    },
    pageSetup: useDocumentStore.getState().pageSetup,
    header: null,
    footer: null
  }
  await window.aiper.docx.write(path.replace(/\.(txt|md)$/, '.docx'), model as never)
  return true
}

function complianceReportText(): string | null {
  const { documentResult } = useComplianceStore.getState()
  if (!documentResult) return null
  const { fileName } = useDocumentStore.getState()
  const { severityCounts, findings, analysedInSeconds } = documentResult
  const lines = [
    `Compliance finding report — ${fileName ?? 'untitled document'}`,
    `Generated ${new Date().toLocaleString()}`,
    '',
    'NOTE: findings come from the built-in example provider. No compliance engine is',
    'connected, so this report must not be used to assess a regulatory document.',
    '',
    `Total findings: ${severityCounts.high + severityCounts.medium + severityCounts.low}`,
    `High: ${severityCounts.high}   Medium: ${severityCounts.medium}   Low: ${severityCounts.low}`,
    `Analysis time: ${analysedInSeconds.toFixed(1)}s`,
    ''
  ]
  for (const f of findings) {
    lines.push(
      `[${f.severity.toUpperCase()}] ${f.title}`,
      `  Location: ${f.location}`,
      `  Rule: ${f.ruleId} (${f.tier})`,
      `  Detection: ${f.detectionMethod} · ${f.precedentCount} precedents`,
      `  ${f.detail}`,
      ''
    )
  }
  return lines.join('\n')
}

export async function runWorkspaceAction(act: string): Promise<void> {
  const ui = useUiStore.getState()
  const doc = useDocumentStore.getState()

  switch (act) {
    // ── File ────────────────────────────────────────────────────────────────────
    case 'file.share': {
      if (!doc.documentId) {
        toast('Only server documents can be shared. Open one from the navigator, or save this to a folder first.', 'warn')
        return
      }
      const ref = `aiper://document/${doc.documentId}?revision=${doc.revision}`
      try {
        await navigator.clipboard.writeText(ref)
        toast('Document reference copied. Anyone with folder access can open it.')
      } catch {
        // Clipboard refused; show the reference so it can be copied by hand.
        await askText('Copy this document reference', ref, { confirmLabel: 'Done' })
      }
      return
    }

    case 'file.protect': {
      const on = doc.toggleRestrictEditing()
      toast(
        on
          ? 'Document protected — editing is disabled until you unprotect it.'
          : 'Protection removed — the document is editable again.'
      )
      return
    }

    // ── Workspace ───────────────────────────────────────────────────────────────
    case 'workspace.rulebook': {
      ui.setDock('compliance', { open: true })
      const summary = RULEBOOK.map((r) => `${r.id} — ${r.title}`).join('\n')
      window.alert(`Rulebook v4.2\n\n${summary}\n\nThese are the rules the example provider reports against.`)
      return
    }

    case 'workspace.history': {
      if (!doc.documentId) {
        toast('Version history is kept for server documents. Open one from the navigator.', 'warn')
        return
      }
      ui.setDock('audit', { open: true })
      return
    }

    // ── Compliance ──────────────────────────────────────────────────────────────
    case 'compliance.showMarkers': {
      ui.setDock('compliance', { open: true })
      const { documentResult } = useComplianceStore.getState()
      if (!documentResult || documentResult.findings.length === 0) {
        toast('No findings to mark. Run Check now first.')
        return
      }
      // Selecting the first finding is what drives the in-document highlight.
      ui.setActiveFinding(documentResult.findings[0].id)
      toast(`${documentResult.findings.length} findings marked in the document.`)
      return
    }

    case 'compliance.findingReport': {
      const text = complianceReportText()
      if (!text) {
        toast('Run Check now first — there is nothing to report yet.', 'warn')
        return
      }
      window.alert(text)
      return
    }

    case 'compliance.exportReport': {
      const text = complianceReportText()
      if (!text) {
        toast('Run Check now first — there is nothing to export yet.', 'warn')
        return
      }
      const name = `${(doc.fileName ?? 'document').replace(/\.docx$/, '')} — compliance report.docx`
      if (await saveTextFile(name, text)) toast('Report saved.')
      return
    }

    case 'compliance.resolveAll': {
      const { documentResult } = useComplianceStore.getState()
      if (!documentResult || documentResult.findings.length === 0) {
        toast('Nothing to resolve.')
        return
      }
      if (
        !window.confirm(
          `Mark all ${documentResult.findings.length} findings as resolved?\n\nThis clears them from the panel. It does not change the document.`
        )
      ) {
        return
      }
      useComplianceStore.setState({
        documentResult: { ...documentResult, findings: [], severityCounts: { high: 0, medium: 0, low: 0 } }
      })
      ui.setActiveFinding(null)
      toast('All findings marked resolved.')
      return
    }

    case 'compliance.crossDoc': {
      ui.setView('folder')
      toast('Cross-document consistency is shown under the folder run.')
      return
    }

    case 'compliance.estimateCost': {
      const { documentResult, folderResult } = useComplianceStore.getState()
      const docs = folderResult?.rows.length ?? (documentResult ? 1 : 0)
      if (docs === 0) {
        toast('Run a check first so there is something to estimate.', 'warn')
        return
      }
      // Local model: the estimate is compute time, not a bill. State that plainly.
      const seconds = folderResult
        ? folderResult.rows.length * 2.4
        : (documentResult?.analysedInSeconds ?? 0)
      window.alert(
        `Estimated analysis cost\n\n` +
          `Documents: ${docs}\n` +
          `Estimated compute: ${seconds.toFixed(1)}s\n` +
          `Model: local — no per-token charge.\n\n` +
          `With a hosted model connected this would show the provider's price instead.`
      )
      return
    }

    // ── Window ──────────────────────────────────────────────────────────────────
    case 'view.newWindow': {
      if (!window.aiper) {
        notImplemented('New window')
        return
      }
      await window.aiper.window.newWindow()
      toast('New window opened.')
      return
    }

    case 'view.sideBySide':
    case 'view.arrangeAll': {
      if (!window.aiper) {
        notImplemented(act === 'view.sideBySide' ? 'Side by side' : 'Arrange all')
        return
      }
      const arranged = await window.aiper.window.arrange(act === 'view.sideBySide' ? 'sideBySide' : 'tile')
      toast(arranged ? 'Windows arranged.' : 'Only one window is open — use New window first.', arranged ? 'info' : 'warn')
      return
    }

    case 'view.split':
      // A split view means two scroll positions over one document inside one window. The
      // editor mounts a single ProseMirror view, so this needs a real second view rather
      // than a flag. Use New window + Side by side for the same effect meanwhile.
      toast('Split view isn’t built. New window followed by Side by side gives two views of your work.', 'warn')
      return

    case 'view.macros':
      // Running user-authored scripts inside the renderer is a security decision, not just
      // a missing feature — it stays unbuilt deliberately.
      toast('Macros are intentionally not supported — Aiper does not execute user scripts.', 'warn')
      return

    case 'voice.dictate':
      // Electron ships no offline recogniser and the Web Speech API routes audio to a cloud
      // service. Not something to switch on silently for regulatory documents.
      toast('Dictation isn’t available — it would send audio to an external service.', 'warn')
      return

    default:
      notImplemented(act)
  }
}
