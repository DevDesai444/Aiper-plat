import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as Y from 'yjs'
import type { Comment, SessionUser } from '@aiper/shared/types'
import { server } from '../msw/server'

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    auth: {
      getSession: vi.fn<
        () => Promise<{ data: { session: { access_token: string } | null } }>
      >(),
    },
  },
}))
vi.mock('../../src/auth/supabase', () => ({ supabase: mockSupabase }))

const { CommentsPanel } = await import('../../src/editor/CommentsPanel')
const { useSessionStore } = await import('../../src/auth/sessionStore')

const DID = '33333333-3333-4333-8333-333333333333'
const ME_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function fakeMe(): SessionUser {
  return {
    id: ME_ID,
    email: 'alice@example.com',
    displayName: 'Alice',
    avatarUrl: null,
    orgMemberships: [],
  }
}

function makeComment(overrides: Partial<Comment> = {}): Comment {
  return {
    id: crypto.randomUUID(),
    documentId: DID,
    markId: 'thread-1',
    quotedText: 'The launch window shifted.',
    body: 'This paragraph needs a citation.',
    authorId: ME_ID,
    authorDisplayName: 'Alice',
    createdAt: '2026-09-11T10:00:00.000Z',
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  }
}

/**
 * A do-nothing pair of callbacks + a real Y.Doc — panel tests do not
 * exercise the compose-apply-mark path; that lives in EditorPage.
 */
function baseProps() {
  return {
    documentId: DID,
    ydoc: new Y.Doc(),
    compose: null,
    onSubmitCompose: vi.fn<(body: string) => Promise<void>>(),
    onCancelCompose: vi.fn<() => void>(),
    onAfterDelete: vi.fn<(markId: string) => void>(),
  }
}

beforeEach(() => {
  mockSupabase.auth.getSession.mockReset()
  mockSupabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'test-token' } },
  })
  useSessionStore.setState({
    status: 'signed-in',
    user: fakeMe(),
    error: null,
    busy: false,
  })
})

describe('CommentsPanel', () => {
  it('viewer sees threads but no compose / resolve / delete controls', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () =>
        HttpResponse.json({
          items: [
            makeComment({ markId: 't1', body: 'nice paragraph' }),
            makeComment({ markId: 't2', body: 'another one' }),
          ],
        }),
      ),
    )
    render(<CommentsPanel {...baseProps()} role="viewer" />)
    await userEvent.click(screen.getByRole('button', { name: /open comments/i }))
    // Both threads render.
    expect(await screen.findByText(/nice paragraph/)).toBeInTheDocument()
    expect(screen.getByText(/another one/)).toBeInTheDocument()
    // No mutation controls for a viewer.
    expect(
      screen.queryByRole('button', { name: /resolve/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /delete/i }),
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('editor: compose prop opens the form, submit calls onSubmitCompose with the body', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () =>
        HttpResponse.json({ items: [] }),
      ),
    )
    const props = baseProps()
    props.onSubmitCompose.mockResolvedValue(undefined)
    const { rerender } = render(
      <CommentsPanel
        {...props}
        role="editor"
        compose={{ markId: 'thread-x', quotedText: 'section anchor' }}
      />,
    )

    const textarea = await screen.findByRole('textbox', { name: /comment body/i })
    await userEvent.type(textarea, 'please cite ECSS-Q-ST-70')
    await userEvent.click(screen.getByRole('button', { name: /^comment$/i }))

    await waitFor(() =>
      expect(props.onSubmitCompose).toHaveBeenCalledWith('please cite ECSS-Q-ST-70'),
    )

    // After success, parent clears compose — simulate that and check the
    // form disappears.
    rerender(<CommentsPanel {...props} role="editor" compose={null} />)
    expect(
      screen.queryByRole('textbox', { name: /comment body/i }),
    ).not.toBeInTheDocument()
  })

  it('editor: resolve button POSTs to the resolve endpoint and refetches', async () => {
    let resolveCalls = 0
    let getCalls = 0
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () => {
        getCalls += 1
        return HttpResponse.json({
          items: [makeComment({ markId: 't1', body: 'first' })],
        })
      }),
      http.post(
        `/api/v1/documents/${DID}/comments/t1/resolve`,
        () => {
          resolveCalls += 1
          return HttpResponse.json({
            comments: [
              makeComment({
                markId: 't1',
                body: 'first',
                resolvedAt: '2026-09-11T11:00:00.000Z',
                resolvedBy: ME_ID,
              }),
            ],
          })
        },
      ),
    )
    render(<CommentsPanel {...baseProps()} role="editor" />)
    await userEvent.click(screen.getByRole('button', { name: /open comments/i }))
    await screen.findByText(/first/)
    const initialGetCalls = getCalls

    await userEvent.click(screen.getByRole('button', { name: /^resolve$/i }))
    await waitFor(() => expect(resolveCalls).toBe(1))
    // Refetch fires after the mutation.
    await waitFor(() => expect(getCalls).toBeGreaterThan(initialGetCalls))
  })

  it('editor: delete button on OWN thread calls DELETE + onAfterDelete', async () => {
    let deleteCalls = 0
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () =>
        HttpResponse.json({
          items: [makeComment({ markId: 't-own', authorId: ME_ID, body: 'mine' })],
        }),
      ),
      http.delete(`/api/v1/documents/${DID}/comments/t-own`, () => {
        deleteCalls += 1
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const props = baseProps()
    render(<CommentsPanel {...props} role="editor" />)
    await userEvent.click(screen.getByRole('button', { name: /open comments/i }))
    await screen.findByText(/mine/)

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(deleteCalls).toBe(1))
    await waitFor(() =>
      expect(props.onAfterDelete).toHaveBeenCalledWith('t-own'),
    )
  })

  it('editor: delete is HIDDEN on a thread they did not author (server would 403 anyway)', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () =>
        HttpResponse.json({
          items: [
            makeComment({
              markId: 't-someone-else',
              authorId: OTHER_ID,
              authorDisplayName: 'Bob',
              body: 'not mine',
            }),
          ],
        }),
      ),
    )
    render(<CommentsPanel {...baseProps()} role="editor" />)
    await userEvent.click(screen.getByRole('button', { name: /open comments/i }))
    await screen.findByText(/not mine/)
    // Resolve is fine (editor+); delete is not visible on other-author.
    expect(screen.getByRole('button', { name: /^resolve$/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /^delete$/i }),
    ).not.toBeInTheDocument()
  })

  it('owner sees delete on every thread regardless of author', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () =>
        HttpResponse.json({
          items: [
            makeComment({
              markId: 't-bob',
              authorId: OTHER_ID,
              authorDisplayName: 'Bob',
              body: 'Bob wrote this',
            }),
          ],
        }),
      ),
    )
    render(<CommentsPanel {...baseProps()} role="owner" />)
    await userEvent.click(screen.getByRole('button', { name: /open comments/i }))
    await screen.findByText(/Bob wrote this/)
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('renders empty-state copy when there are no comments', async () => {
    server.use(
      http.get(`/api/v1/documents/${DID}/comments`, () =>
        HttpResponse.json({ items: [] }),
      ),
    )
    render(<CommentsPanel {...baseProps()} role="editor" />)
    await userEvent.click(screen.getByRole('button', { name: /open comments/i }))
    expect(
      await screen.findByText(/No comments yet/i),
    ).toBeInTheDocument()
  })

  it('caller with no grant (role null) renders nothing at all', () => {
    render(<CommentsPanel {...baseProps()} role={null} />)
    // No FAB either — the caller cannot GET the list, so we hide entry.
    expect(
      screen.queryByRole('button', { name: /open comments/i }),
    ).not.toBeInTheDocument()
    cleanup()
  })
})
