import { create } from 'zustand'
import type { ChatCitation } from '../../../main/services/ai/AiProvider'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  cites?: ChatCitation[]
}

interface ChatState {
  threadId: string
  messages: ChatMessage[]
  status: string | null
  streamingId: string | null

  addUserMessage: (text: string) => void
  setStatus: (status: string | null) => void
  appendToken: (token: string) => void
  completeMessage: (message: ChatMessage) => void
}

const SEED_MESSAGES: ChatMessage[] = [
  {
    id: 'seed-1',
    role: 'user',
    text: 'What dissolution acceptance criteria have recent ANDAs used for comparable transdermal systems?'
  },
  {
    id: 'seed-2',
    role: 'assistant',
    text: 'Across recent ANDAs, Q = 80% in 30 minutes is the most common single-point criterion, with a few submissions specifying a two-tier profile instead. Ask a question below to continue — the AI research companion is not yet connected to a live model.',
    cites: [
      { label: 'ANDA 209-114', kind: 'anda' },
      { label: 'ANDA 212-880', kind: 'anda' },
      { label: 'Rule CMC-114', kind: 'rule' }
    ]
  }
]

export const useChatStore = create<ChatState>((set) => ({
  threadId: 'main',
  messages: SEED_MESSAGES,
  status: null,
  streamingId: null,

  addUserMessage: (text) =>
    set((s) => ({
      messages: [...s.messages, { id: `u-${Date.now()}`, role: 'user', text }]
    })),

  setStatus: (status) => set({ status }),

  appendToken: (token) =>
    set((s) => {
      const streamingId = s.streamingId ?? `a-${Date.now()}`
      const existing = s.messages.find((m) => m.id === streamingId)
      if (existing) {
        return {
          streamingId,
          status: null,
          messages: s.messages.map((m) => (m.id === streamingId ? { ...m, text: m.text + token } : m))
        }
      }
      return {
        streamingId,
        status: null,
        messages: [...s.messages, { id: streamingId, role: 'assistant', text: token }]
      }
    }),

  completeMessage: (message) =>
    set((s) => ({
      streamingId: null,
      status: null,
      messages: s.messages.map((m) => (m.id === s.streamingId ? message : m))
    }))
}))
