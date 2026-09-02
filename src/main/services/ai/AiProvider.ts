export interface ChatCitation {
  label: string
  kind: 'anda' | 'rule' | 'action'
}

export interface ChatMessageResult {
  id: string
  role: 'assistant'
  text: string
  cites: ChatCitation[]
}

export type StreamChunk =
  | { kind: 'status'; text: string }
  | { kind: 'token'; text: string }
  | { kind: 'done'; message: ChatMessageResult }

export interface AiProvider {
  sendMessage(threadId: string, text: string, onChunk: (chunk: StreamChunk) => void): Promise<ChatMessageResult>
}
