import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { useSessionStore } from '../auth/sessionStore'
import './pages.css'

type Mode = 'password' | 'magic'

const PasswordFormSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password required'),
})
type PasswordForm = z.infer<typeof PasswordFormSchema>

const MagicFormSchema = z.object({
  email: z.string().email('Enter a valid email address'),
})
type MagicForm = z.infer<typeof MagicFormSchema>

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('password')
  const [magicSent, setMagicSent] = useState(false)
  const status = useSessionStore((s) => s.status)
  const busy = useSessionStore((s) => s.busy)
  const error = useSessionStore((s) => s.error)
  const signInWithPassword = useSessionStore((s) => s.signInWithPassword)
  const signInWithMagicLink = useSessionStore((s) => s.signInWithMagicLink)
  const location = useLocation()
  const navigate = useNavigate()

  // Land wherever the user was trying to go before the guard bounced them.
  // Also handles "already signed in but on /login" — they get moved out.
  useEffect(() => {
    if (status === 'signed-in') {
      const from = (location.state as { from?: string } | null)?.from ?? '/'
      navigate(from, { replace: true })
    }
  }, [status, location.state, navigate])

  return (
    <div className="centered-page">
      <div className="login-card">
        <h1 className="login-title">Aiper</h1>
        <p className="login-subtitle">Sign in to continue</p>

        {error && <div className="login-error">{error}</div>}
        {magicSent && mode === 'magic' && !error && (
          <div className="login-info">
            Check your inbox — the link will bring you back here signed in.
          </div>
        )}

        {mode === 'password' ? (
          <PasswordForm
            busy={busy}
            onSubmit={(v) => void signInWithPassword(v.email, v.password)}
          />
        ) : (
          <MagicForm
            busy={busy}
            onSubmit={async (v) => {
              setMagicSent(false)
              await signInWithMagicLink(v.email)
              setMagicSent(true)
            }}
          />
        )}

        <button
          type="button"
          className="login-toggle"
          onClick={() => {
            setMode(mode === 'password' ? 'magic' : 'password')
            setMagicSent(false)
          }}
        >
          {mode === 'password'
            ? 'Sign in with a magic link instead'
            : 'Sign in with a password instead'}
        </button>
      </div>
    </div>
  )
}

function PasswordForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (values: PasswordForm) => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<PasswordForm>({ resolver: zodResolver(PasswordFormSchema) })

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="login-field">
        <label htmlFor="email">Email</label>
        <input id="email" type="email" autoComplete="email" {...register('email')} />
        {errors.email && <span className="login-field-error">{errors.email.message}</span>}
      </div>
      <div className="login-field">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          {...register('password')}
        />
        {errors.password && (
          <span className="login-field-error">{errors.password.message}</span>
        )}
      </div>
      <button type="submit" className="login-submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

function MagicForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (values: MagicForm) => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<MagicForm>({ resolver: zodResolver(MagicFormSchema) })

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="login-field">
        <label htmlFor="magic-email">Email</label>
        <input
          id="magic-email"
          type="email"
          autoComplete="email"
          {...register('email')}
        />
        {errors.email && <span className="login-field-error">{errors.email.message}</span>}
      </div>
      <button type="submit" className="login-submit" disabled={busy}>
        {busy ? 'Sending…' : 'Email me a magic link'}
      </button>
    </form>
  )
}
