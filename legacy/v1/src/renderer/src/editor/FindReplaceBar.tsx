import { useMemo, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { X, ChevronUp, ChevronDown } from 'lucide-react'
import { findAll, selectMatch, replaceMatch, replaceAll } from './findReplace'

interface FindReplaceBarProps {
  editor: Editor
  showReplace: boolean
  onClose: () => void
}

export default function FindReplaceBar({ editor, showReplace, onClose }: FindReplaceBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [index, setIndex] = useState(0)

  const matches = useMemo(() => findAll(editor, query), [editor, query, editor.state.doc])

  const goTo = (i: number): void => {
    if (matches.length === 0) return
    const next = ((i % matches.length) + matches.length) % matches.length
    setIndex(next)
    selectMatch(editor, matches[next])
  }

  return (
    <div className="find-replace-bar">
      <input
        autoFocus
        placeholder="Find"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setIndex(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') goTo(index + (e.shiftKey ? -1 : 1))
          if (e.key === 'Escape') onClose()
        }}
      />
      <span className="find-replace-count">{matches.length > 0 ? `${index + 1}/${matches.length}` : '0/0'}</span>
      <button type="button" onClick={() => goTo(index - 1)} aria-label="Previous match">
        <ChevronUp size={13} strokeWidth={1.5} />
      </button>
      <button type="button" onClick={() => goTo(index + 1)} aria-label="Next match">
        <ChevronDown size={13} strokeWidth={1.5} />
      </button>

      {showReplace && (
        <>
          <input
            placeholder="Replace with"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button
            type="button"
            className="find-replace-text-btn"
            onClick={() => {
              if (matches[index]) replaceMatch(editor, matches[index], replacement)
            }}
          >
            Replace
          </button>
          <button
            type="button"
            className="find-replace-text-btn"
            onClick={() => replaceAll(editor, query, replacement)}
          >
            Replace all
          </button>
        </>
      )}

      <button type="button" onClick={onClose} aria-label="Close find">
        <X size={13} strokeWidth={1.5} />
      </button>
    </div>
  )
}
