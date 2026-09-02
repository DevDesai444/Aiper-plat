import type { AiProvider, ChatMessageResult, StreamChunk } from '../AiProvider'

/**
 * Placeholder implementation — no real LLM is connected yet (decided with the user:
 * stub for now, wire a provider once one is chosen). Mirrors the mockup's chat UX
 * exactly: a "Searching precedent index" status pulse, a streamed reply, then
 * citation chips. Swap `aiProvider` in ../provider.ts for a real implementation
 * of AiProvider later; the dock UI and IPC channel do not need to change.
 */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function canned(userText: string): { text: string; cites: ChatMessageResult['cites'] } {
  const lower = userText.toLowerCase()
  if (lower.includes('precedent') || lower.includes('dissolution')) {
    return {
      text: 'Across recent ANDAs, dissolution acceptance criteria for comparable transdermal systems most commonly land at Q = 80% in 30 minutes, with a handful specifying a two-tier profile. This is a placeholder response — Aiper’s AI research companion is not yet connected to a live model or the real precedent index.',
      cites: [
        { label: 'ANDA 209-114', kind: 'anda' },
        { label: 'ANDA 212-880', kind: 'anda' },
        { label: 'Rule CMC-114', kind: 'rule' }
      ]
    }
  }
  if (lower.includes('draft') || lower.includes('insert')) {
    return {
      text: 'Here is placeholder draft language for this section. Once a real model is wired in, this reply will be grounded in your rulebook and precedent index rather than canned text.',
      cites: [
        { label: 'Insert draft', kind: 'action' },
        { label: 'Open side by side', kind: 'action' }
      ]
    }
  }
  return {
    text: `I don't have a live model connected yet, so this is a placeholder reply to "${userText.slice(0, 80)}". Wire a real AiProvider in src/main/services/ai/provider.ts to replace this.`,
    cites: []
  }
}

export class StubAiProvider implements AiProvider {
  async sendMessage(_threadId: string, text: string, onChunk: (chunk: StreamChunk) => void): Promise<ChatMessageResult> {
    onChunk({ kind: 'status', text: 'Searching precedent index — 41 ANDAs' })
    await sleep(650)

    const { text: replyText, cites } = canned(text)
    const words = replyText.split(' ')
    let acc = ''
    for (const word of words) {
      acc += (acc ? ' ' : '') + word
      onChunk({ kind: 'token', text: word + ' ' })
      await sleep(18)
    }

    const message: ChatMessageResult = { id: `m-${Date.now()}`, role: 'assistant', text: acc, cites }
    onChunk({ kind: 'done', message })
    return message
  }
}
