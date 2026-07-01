# AGENTS.md

## Cursor Cloud specific instructions

`omas` (oh-my-agent-shell) is a self-hosted web terminal: a TypeScript/Fastify server (PTY, WebSocket, auth, git/fs/share APIs) plus a Svelte 5 + Vite frontend. Standard dev/test/build commands live in `README.md` ("开发" section), `CONTRIBUTING.md`, and `package.json` `scripts`; use those as the source of truth. Node >=22 is required and already available.

Running the app in dev (two long-running processes; run each in its own tmux session, not the update script):
- API + WebSocket: `OMAS_PASSWORD=devpass npm run dev:server` → http://127.0.0.1:7681 (writes config to `./.dev-config`).
- Frontend: `npm run dev:web` → http://localhost:5173 (Vite proxies `/api` and WS to `:7681`). Open the app at `:5173`, not `:7681`, in dev.

Non-obvious caveats:
- Login: when `OMAS_PASSWORD` is set, the server migrates it into an `admin` account. Log in with username `admin` (single-user setups can omit the username) and that password (`devpass` above). With no accounts and no `OMAS_PASSWORD`, the server runs in open (no-auth) mode.
- Tests: `tests/locale.unit.test.ts` reads real locale env vars and fails if `LC_ALL` is set to a UTF-8 value (this VM sets `LC_ALL=en_US.UTF-8`), because the test sets `LANG` without clearing the higher-priority `LC_ALL`. This is an environment sensitivity, not a code bug — run the suite with `env -u LC_ALL npm test` for a clean pass. `npm run typecheck` (tsc + svelte-check) is unaffected.
- Production build (`npm run build`) bootstraps the Bun runtime to compile a single binary and is NOT needed for development; dev mode serves the frontend via Vite. `npm install` runs a `prepare` hook that writes a stub `src/server/web-assets.gen.ts` (real assets are only embedded during `npm run build`) — this stub is expected in dev.
- PTY (`@homebridge/node-pty-prebuilt-multiarch`) and `argon2` are native addons installed as prebuilt binaries via `npm install`.
