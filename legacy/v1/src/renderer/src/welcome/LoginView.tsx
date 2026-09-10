import { useState, useEffect, useRef } from 'react'
import { AlertCircle, Github, Copy, Check, ExternalLink } from 'lucide-react'
import logo from '../assets/aiper-logo.png'
import BlueprintCard from '../common/BlueprintCard'
import { useSessionStore } from '../store/sessionStore'

/**
 * Sign in.
 *
 * GitHub is the whole of it. Aiper issues no accounts, holds no passwords and has no server,
 * so there is nothing to create, nothing to type, and no address to configure — you approve a
 * short code on github.com and the projects you have been added to are already there.
 */
export default function LoginView(): React.JSX.Element {
  const signInWithToken = useSessionStore((s) => s.signInWithToken)
  const error = useSessionStore((s) => s.error)

  const [configured, setConfigured] = useState<boolean | null>(null)
  const [device, setDevice] = useState<{ userCode: string; verificationUri: string } | null>(null)
  const [ghError, setGhError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [needsAccount, setNeedsAccount] = useState(false)
  const cancelled = useRef(false)

  useEffect(() => {
    window.aiper?.github
      ?.isConfigured()
      .then(setConfigured)
      .catch(() => setConfigured(false))
    return () => {
      cancelled.current = true
    }
  }, [])

  const fail = (message: string): void => {
    setGhError(message)
    setDevice(null)
  }

  const start = async (): Promise<void> => {
    setBusy(true)
    setGhError(null)
    cancelled.current = false
    try {
      const begin = await window.aiper.github.startDeviceFlow()
      setDevice({ userCode: begin.userCode, verificationUri: begin.verificationUri })
      void window.aiper.openExternal(begin.verificationUri)

      // Poll at the interval GitHub asked for; it tells us to slow down if we go too fast.
      let interval = begin.interval
      const deadline = Date.now() + begin.expiresIn * 1000
      while (!cancelled.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval * 1000))
        if (cancelled.current) return
        const result = await window.aiper.github.pollDeviceFlow(begin.deviceCode)
        if (result.status === 'ok') {
          await signInWithToken(result.token)
          return
        }
        if (result.status === 'slow_down') interval = result.interval
        if (result.status === 'denied') return fail('Sign-in was declined on GitHub.')
        if (result.status === 'expired') return fail('That code expired. Start again.')
        if (result.status === 'error') return fail(result.error)
      }
      if (!cancelled.current) fail('That code expired. Start again.')
    } catch (err) {
      fail(err instanceof Error ? err.message : 'Could not reach GitHub.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-view">
      <img src={logo} alt="Aiper" className="login-logo" />
      <h1>Aiper</h1>
      <p className="login-subtitle">Regulatory document authoring</p>

      <BlueprintCard className="login-card">
        {configured === false && (
          <div className="login-unreachable">
            <AlertCircle size={20} strokeWidth={1.5} />
            <p className="login-unreachable-lead">GitHub sign-in isn’t set up</p>
            <p className="login-unreachable-detail">
              This copy of Aiper was started without a GitHub client id, so there is no way to sign
              in. Start it with <code>AIPER_GITHUB_CLIENT_ID</code> set — see the README.
            </p>
          </div>
        )}

        {configured === true && !device && (
          <>
            <button type="button" className="login-github" disabled={busy} onClick={() => void start()}>
              <Github size={15} strokeWidth={1.5} />
              {busy ? 'Opening GitHub…' : 'Sign in with GitHub'}
            </button>
            <button type="button" className="login-link" onClick={() => setNeedsAccount(true)}>
              I don’t have a GitHub account
            </button>
          </>
        )}

        {device && (
          <div className="login-device">
            <p className="login-device-lead">Enter this code on GitHub:</p>
            <div className="login-device-code">
              <code>{device.userCode}</code>
              <button
                type="button"
                aria-label="Copy code"
                onClick={() => {
                  void navigator.clipboard.writeText(device.userCode)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1500)
                }}
              >
                {copied ? <Check size={13} strokeWidth={1.5} /> : <Copy size={13} strokeWidth={1.5} />}
              </button>
            </div>
            <button
              type="button"
              className="login-link"
              onClick={() => void window.aiper.openExternal(device.verificationUri)}
            >
              <ExternalLink size={12} strokeWidth={1.5} /> {device.verificationUri}
            </button>
            <p className="login-device-wait">Waiting for you to approve…</p>
            <button
              type="button"
              className="login-link"
              onClick={() => {
                cancelled.current = true
                setDevice(null)
              }}
            >
              Cancel
            </button>
          </div>
        )}

        {(ghError || error) && (
          <div className="login-error">
            <AlertCircle size={13} strokeWidth={1.5} />
            <span>{ghError ?? error}</span>
          </div>
        )}
      </BlueprintCard>

      <p className="login-footnote">
        Projects follow your GitHub account — sign in on any machine and everything you have been
        added to is already there.
      </p>

      {needsAccount && (
        <div className="dialog-backdrop" onClick={() => setNeedsAccount(false)}>
          <BlueprintCard className="login-nudge" onClick={() => undefined}>
            <div onClick={(e) => e.stopPropagation()}>
              <Github size={22} strokeWidth={1.5} />
              <h2>Make a GitHub account</h2>
              <p>It takes a minute and it’s free. Then sign in here.</p>
              <button
                type="button"
                className="login-submit"
                onClick={() => {
                  void window.aiper.openExternal('https://github.com/signup')
                  setNeedsAccount(false)
                }}
              >
                Open github.com/signup
              </button>
              <button type="button" className="login-link" onClick={() => setNeedsAccount(false)}>
                Close
              </button>
            </div>
          </BlueprintCard>
        </div>
      )}
    </div>
  )
}
