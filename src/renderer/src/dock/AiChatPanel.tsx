import { useEffect, useRef, useState } from 'react'
import { Send } from 'lucide-react'
import BlueprintCard from '../common/BlueprintCard'
import { useChatStore } from '../store/chatStore'

const CHIPS = ['Precedent for this ¶', 'Explain rule CMC-114', 'Summarise 3.2.P.5', 'Cite ICH Q6A']

export default function AiChatPanel(): React.JSX.Element {
  const messages = useChatStore((s) => s.messages)
  const status = useChatStore((s) => s.status)
  const addUserMessage = useChatStore((s) => s.addUserMessage)
  const setStatus = useChatStore((s) => s.setStatus)
  const appendToken = useChatStore((s) => s.appendToken)
  const completeMessage = useChatStore((s) => s.completeMessage)
  const [input, setInput] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!window.aiper) return
    return window.aiper.ai.onMessageChunk((_threadId, chunk) => {
      if (chunk.kind === 'status') setStatus(chunk.text)
      else if (chunk.kind === 'token') appendToken(chunk.text)
      else if (chunk.kind === 'done') completeMessage(chunk.message)
    })
  }, [appendToken, completeMessage, setStatus])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages, status])

  const send = (text: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    addUserMessage(trimmed)
    setInput('')
    if (window.aiper) void window.aiper.ai.sendMessage('main', trimmed)
  }

  return (
    <div className="chat-panel">
      <div className="stub-banner">
        <strong>Not connected.</strong> No model is wired up — replies are canned placeholders.
      </div>
      <div className="chat-messages" ref={listRef}>
        {messages.map((m) => (
          <div key={m.id} className={`chat-message chat-message--${m.role}`}>
            <div className="chat-message-role">{m.role === 'user' ? 'You' : 'Aiper'}</div>
            <div className="chat-bubble">{m.text}</div>
            {m.cites && m.cites.length > 0 && (
              <div className="chat-cites">
                {m.cites.map((c) => (
                  <span key={c.label} className="chat-cite-chip">
                    {c.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {status && (
          <div className="chat-status">
            <span className="chat-status-dot" />
            {status}
          </div>
        )}
      </div>

      <div className="chat-chips">
        {CHIPS.map((chip) => (
          <button key={chip} type="button" className="chat-chip" onClick={() => send(chip)}>
            {chip}
          </button>
        ))}
      </div>

      <BlueprintCard className="chat-input">
        <textarea
          value={input}
          placeholder="Ask about precedent, guidance, or this section…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send(input)
            }
          }}
        />
        <button type="button" className="chat-send-btn" onClick={() => send(input)} aria-label="Send">
          <Send size={14} strokeWidth={1.5} />
        </button>
      </BlueprintCard>
      <div className="chat-footer">
        <span>Grounded · rulebook v4.2 + 41 ANDAs</span>
        <span>Ctrl ↵ to send</span>
      </div>
    </div>
  )
}
