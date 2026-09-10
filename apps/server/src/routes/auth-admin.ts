import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { ApiErrorSchema } from '@aiper/shared/schemas'
import type { Config } from '../config.js'

/**
 * POST /api/v1/auth/signup — server-side signup that bypasses Supabase's
 * public /auth/v1/signup entirely. We call Supabase's admin API with the
 * project's service_role key, passing `email_confirm: true`, which:
 *   - creates the user
 *   - marks the email confirmed on our behalf (no verification email)
 *   - counts against no email quota (no email is sent)
 *
 * Why this exists: Supabase's public signup enforces the project's
 * `mailer_autoconfirm` setting. On default projects that setting is off,
 * which sends a confirmation email — throttled to a handful per hour on
 * the shared SMTP. A first-hand demo hitting the rate limit twice looks
 * like the app is broken. This endpoint sidesteps that entirely.
 *
 * The frontend calls this and, on success, calls
 * supabase.auth.signInWithPassword() to establish the session. The
 * server never touches sessions — Supabase JS owns the tokens.
 */

const SignupBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

const SignupOkSchema = z.object({
  ok: z.literal(true),
  userId: z.string().uuid(),
})

export function registerAuthAdminRoute(app: FastifyInstance, config: Config): void {
  app.post(
    '/api/v1/auth/signup',
    {
      schema: {
        summary: 'Server-side signup via Supabase admin API (no email confirmation)',
        body: SignupBodySchema,
        response: {
          200: SignupOkSchema,
          400: ApiErrorSchema,
          409: ApiErrorSchema,
          501: ApiErrorSchema,
          502: ApiErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = config
      if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        return reply.code(501).send({
          error:
            'Server-side signup is not configured. Set SUPABASE_URL and ' +
            'SUPABASE_SERVICE_ROLE_KEY in apps/server/.env.',
          code: 'signup_not_configured',
        })
      }

      const body = req.body as z.infer<typeof SignupBodySchema>

      let resp: Response
      try {
        resp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: body.email,
            password: body.password,
            email_confirm: true,
          }),
        })
      } catch (err) {
        req.log.error({ err }, 'Supabase admin API unreachable')
        return reply.code(502).send({
          error: 'Could not reach Supabase to create the account.',
          code: 'supabase_unreachable',
        })
      }

      const text = await resp.text()
      let parsed: unknown = {}
      try {
        parsed = JSON.parse(text)
      } catch {
        // fall through — parsed stays empty; we'll surface the raw text.
      }

      if (!resp.ok) {
        // Duplicate email → 422 or 400 depending on API version. Surface as 409.
        const msg =
          (parsed as { msg?: string; error?: string }).msg ??
          (parsed as { msg?: string; error?: string }).error ??
          text ??
          'Supabase rejected the signup.'
        const status = resp.status === 422 || resp.status === 400 ? 409 : 400
        req.log.warn({ status: resp.status, msg }, 'Supabase admin.createUser failed')
        return reply.code(status).send({
          error: msg,
          code: status === 409 ? 'user_exists_or_invalid' : 'supabase_rejected',
        })
      }

      const created = parsed as { id?: string }
      if (!created.id) {
        req.log.error({ parsed }, 'Supabase returned success without a user id')
        return reply.code(502).send({
          error: 'Supabase created the user but returned no id.',
          code: 'unexpected_shape',
        })
      }

      return reply.code(200).send({ ok: true, userId: created.id })
    },
  )
}
