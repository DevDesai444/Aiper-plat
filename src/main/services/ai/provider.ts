import type { AiProvider } from './AiProvider'
import { StubAiProvider } from './stub/StubAiProvider'

/** Single swap point: replace with a real AiProvider (Claude, OpenAI, or an internal
 *  Aiper endpoint) once one is chosen. Nothing outside this file needs to change. */
export const aiProvider: AiProvider = new StubAiProvider()
