# @aiper/web

Aiper v2 web frontend. Vite + React 18 SPA that runs against `@aiper/server`.

## Setup

```bash
# From the repo root
pnpm install

# One-time: copy env template for the Supabase publishable key
cp apps/web/.env.example apps/web/.env
```

The frontend calls `/api/v1/...` on the same origin. In dev, Vite proxies those
paths to Fastify at `http://127.0.0.1:8787` (see `vite.config.ts`). In prod,
`@fastify/static` serves the built SPA from the same origin. There is no
`VITE_API_URL` — the frontend has no business knowing where the API lives.

## Run

```bash
# Terminal 1 — Fastify (needs its own .env; see apps/server/.env.example)
pnpm --filter @aiper/server dev

# Terminal 2 — Vite dev server on http://localhost:5173
pnpm --filter @aiper/web dev
```

## Test / typecheck

```bash
pnpm --filter @aiper/web typecheck
pnpm --filter @aiper/web test
```

Or from the repo root: `pnpm typecheck` / `pnpm test` runs all workspaces.

## Design tokens

Ported from `legacy/v1/src/renderer/src/design/` into `src/design/`:

- `tokens.css` — CSS custom properties for colors, fonts, and shell rail sizes.
  Every component reads from these; never hardcode a color or a rail width.
- `fonts.css` — `@fontsource/barlow*` imports.
- `blueprint.css` — the corner-tick card used across dialogs.

`src/main.tsx` imports all three in that order. To reference tokens in a new
component's CSS, use the variable names in `tokens.css` (`var(--ink)`,
`var(--chrome)`, `var(--titlebar-h)`, …) so a future theme swap stays a
single-file change.

## Layout

- `src/auth/` — Supabase client singleton + `sessionStore` (Zustand facade over
  `supabase.auth.onAuthStateChange`).
- `src/api/` — `apiFetch<T>({ schema })` fetch wrapper (attaches
  `Authorization: Bearer <supabase JWT>`, Zod-parses the response, throws a
  typed error).
- `src/router/` — `createBrowserRouter` + `<RequireSession>` guard.
- `src/pages/` — top-level route components.
