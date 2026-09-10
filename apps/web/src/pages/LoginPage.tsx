import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { useSessionStore } from '../auth/sessionStore'
import './pages.css'

type Mode = 'signin' | 'signup' | 'magic'

const SigninFormSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(1, 'Password required'),
})
type SigninForm = z.infer<typeof SigninFormSchema>

const SignupFormSchema = z.object({
  email: z.string().email('Enter a valid email address'),
  password: z.string().min(8, 'At least 8 characters'),
})
type SignupForm = z.infer<typeof SignupFormSchema>

const MagicFormSchema = z.object({
  email: z.string().email('Enter a valid email address'),
})
type MagicForm = z.infer<typeof MagicFormSchema>

const HEADINGS: Record<Mode, { title: string; subtitle: string }> = {
  signin: { title: 'Aiper', subtitle: 'Sign in to continue' },
  signup: { title: 'Aiper', subtitle: 'Create your account' },
  magic: { title: 'Aiper', subtitle: 'Sign in with a magic link' },
}

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const [magicSent, setMagicSent] = useState(false)
  const status = useSessionStore((s) => s.status)
  const busy = useSessionStore((s) => s.busy)
  const error = useSessionStore((s) => s.error)
  const signInWithPassword = useSessionStore((s) => s.signInWithPassword)
  const signUpWithPassword = useSessionStore((s) => s.signUpWithPassword)
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

  const heading = HEADINGS[mode]

  return (
    <div className="centered-page">
      <div className="login-card">
        <h1 className="login-title">{heading.title}</h1>
        <p className="login-subtitle">{heading.subtitle}</p>

        {error && <div className="login-error">{error}</div>}
        {magicSent && mode === 'magic' && !error && (
          <div className="login-info">
            Check your inbox — the link will bring you back here signed in.
          </div>
        )}

        {mode === 'signin' && (
          <SigninFormFields
            busy={busy}
            onSubmit={(v) => void signInWithPassword(v.email, v.password)}
          />
        )}
        {mode === 'signup' && (
          <SignupFormFields
            busy={busy}
            onSubmit={(v) => void signUpWithPassword(v.email, v.password)}
          />
        )}
        {mode === 'magic' && (
          <MagicFormFields
            busy={busy}
            onSubmit={async (v) => {
              setMagicSent(false)
              await signInWithMagicLink(v.email)
              setMagicSent(true)
            }}
          />
        )}

        <div className="login-alt-actions">
          {mode !== 'signin' && (
            <button
              type="button"
              className="login-toggle"
              onClick={() => {
                setMode('signin')
                setMagicSent(false)
              }}
            >
              Sign in with a password
            </button>
          )}
          {mode !== 'signup' && (
            <button
              type="button"
              className="login-toggle"
              onClick={() => {
                setMode('signup')
                setMagicSent(false)
              }}
            >
              Create a new account
            </button>
          )}
          {mode !== 'magic' && (
            <button
              type="button"
              className="login-toggle"
              onClick={() => {
                setMode('magic')
                setMagicSent(false)
              }}
            >
              Sign in with a magic link
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function SigninFormFields({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (values: SigninForm) => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SigninForm>({ resolver: zodResolver(SigninFormSchema) })

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="login-field">
        <label htmlFor="signin-email">Email</label>
        <input
          id="signin-email"
          type="email"
          autoComplete="email"
          {...register('email')}
        />
        {errors.email && <span className="login-field-error">{errors.email.message}</span>}
      </div>
      <div className="login-field">
        <label htmlFor="signin-password">Password</label>
        <input
          id="signin-password"
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

function SignupFormFields({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (values: SignupForm) => void
}) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SignupForm>({ resolver: zodResolver(SignupFormSchema) })

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate>
      <div className="login-field">
        <label htmlFor="signup-email">Email</label>
        <input
          id="signup-email"
          type="email"
          autoComplete="email"
          {...register('email')}
        />
        {errors.email && <span className="login-field-error">{errors.email.message}</span>}
      </div>
      <div className="login-field">
        <label htmlFor="signup-password">Password (at least 8 characters)</label>
        <input
          id="signup-password"
          type="password"
          autoComplete="new-password"
          {...register('password')}
        />
        {errors.password && (
          <span className="login-field-error">{errors.password.message}</span>
        )}
      </div>
      <button type="submit" className="login-submit" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  )
}

function MagicFormFields({
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
