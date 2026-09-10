import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useLocation, useNavigate } from 'react-router-dom'
import { z } from 'zod'
import { useSessionStore } from '../auth/sessionStore'
import './pages.css'

type Mode = 'signin' | 'signup'

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

const HEADINGS: Record<Mode, { subtitle: string }> = {
  signin: { subtitle: 'Sign in to continue' },
  signup: { subtitle: 'Create your account' },
}

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin')
  const status = useSessionStore((s) => s.status)
  const busy = useSessionStore((s) => s.busy)
  const error = useSessionStore((s) => s.error)
  const signInWithPassword = useSessionStore((s) => s.signInWithPassword)
  const signUpWithPassword = useSessionStore((s) => s.signUpWithPassword)
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
        <p className="login-subtitle">{HEADINGS[mode].subtitle}</p>

        {error && <div className="login-error">{error}</div>}

        {mode === 'signin' ? (
          <SigninFormFields
            busy={busy}
            onSubmit={(v) => void signInWithPassword(v.email, v.password)}
          />
        ) : (
          <SignupFormFields
            busy={busy}
            onSubmit={(v) => void signUpWithPassword(v.email, v.password)}
          />
        )}

        <button
          type="button"
          className="login-toggle"
          onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}
        >
          {mode === 'signin' ? 'Create a new account' : 'Sign in with a password instead'}
        </button>
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
