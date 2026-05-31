# omas

**中文：** [README.md](./README.md)

> Too much context in the agent era. **omas splits each task into its own session** — terminal-first, disposable browser tabs, agents keep running in the background; local AI history is scanned automatically so you can resume anytime.

A self-hosted web terminal for AI-assisted development. Not an agent, not an IDE replacement — a **lightweight shell console that reduces memory load**: the main view is the terminal; side panels cover just enough file editing and AI diff review. A single binary, open in any browser.

[![Release](https://img.shields.io/github/v/release/lilymoonight/omas)](https://github.com/lilymoonight/omas/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

```text
┌──────────┬──────────────────────────────┬──────────┐
│ files    │  v ~/work/api    * Cursor    │ git diff │
│ edit env │    # session A  claude       │ review   │
│ click=ok │    # session B  npm test     │ AI edits │
│          │  > ~/work/web   (2)          │ $EDITOR  │
└──────────┴──────────────────────────────┴──────────┘
  light edit     ↑ multi-session · grouping · Cmd/F search · agent state    glance, then merge
```

## Features

### Terminal core

- **Multi-session management** — one session per task, clear at a glance; create / rename / destroy.
- **Background server-side PTY** — the server owns the PTY; closing a browser tab only disconnects the view, refresh to reconnect — **agents never stop**.
- **In-terminal search** — `Cmd/Ctrl+F` searches the scrollback, highlights matches with a current/total counter, supports case-sensitive / regex; only intercepted on the normal buffer, so full-screen TUIs (vim, agent TUIs) keep their own `Ctrl+F`.
- **Drag-and-drop upload** — drop files onto the terminal to upload into the session's current directory; large files are auto-chunked and parallelized, cancellable, with live progress.
- **Theming** — light / dark / follow-system, no first-paint flash, xterm colors switch live.
- **Smooth rendering** — xterm.js + WebGL, automatic link detection, copy via native browser selection (`Cmd/Ctrl+C`).

### Agent workflow

- **AI history scan & resume** — auto-scan local Claude / Cursor / Qoder / OpenCode session history, grouped by project, one-click `cd` + `--resume`.
- **Agent badge** — cards detect the foreground agent (even when wrapped by node / python); others show the command name; idle shells show nothing.
- **Active / idle detection** — judged by CPU sampling of the agent's process subtree ("working" with a green pulse / "idle"), avoiding false flicker from TUI repaints.
- **Idle notifications** — when an agent goes from "working" to "idle," a system notification fires in the background tab (click to open the session), with a pending badge on the title and favicon that clears when you return.
- **Group sessions by project** — clustered by live working directory with an oh-my-zsh-style colorful path breadcrumb; collapsible, state persisted.
- **Live working directory** — cards show each session's live cwd (follows `cd`).

### Files & change review

- **File tree + light editing** — open small files in the sidebar and save with CodeMirror, no IDE switch.
- **Git panel** — centrally review what the agent changed: diff / light edit / hand off to `$EDITOR` in the terminal.

### Sharing & hosting

- **Public static sites (no auth)** — mount any directory at `/p/<slug>/` for password-free access, to share build output, reports, etc. as web pages. A **publish admin page** adds/removes sites online, persists changes, and **takes effect immediately without a restart**; missing `index.html` falls back to a Python `http.server`-style **directory listing**; SPA mode falls back to `index.html`; built-in path-traversal protection (rejects `..` / absolute paths / NUL).

### Deploy & ops

- **Single binary** — four-architecture releases (linux / darwin × x64 / arm64), no native deps (password hashing uses Bun's built-in argon2id).
- **Password & daemon** — `omas init` (persisted argon2id password), `omas service install` (launchd / systemd background daemon — agents survive browser close).
- **Reverse-proxy friendly** — adapts to reverse-proxy prefixes, WebSocket, HTTPS (see [DEPLOY.md](./DEPLOY.md)).

## Quick start

**Download a binary** (recommended): [Releases](https://github.com/lilymoonight/omas/releases) — pick `omas-*`, or build it:

```bash
git clone https://github.com/lilymoonight/omas.git && cd omas
npm install && npm run build    # → release/omas

chmod +x release/omas
./release/omas serve --port 7681
# http://127.0.0.1:7681 (no password by default; use omas init in production)
```

```bash
omas init                       # persist login password
omas install --prefix ~/.local/bin
omas service install            # background daemon — agents survive browser close
```

## Core idea: keep context light

When you juggle Claude, Cursor, three repos, and five agents at once, **the hard part is not running commands — it is remembering which window is doing what**. omas moves that context out of your head and onto the screen:

```text
  Your brain                          What omas remembers
  ─────────                          ────────────────────
  "Agent is running tests here"  →    Session list + groups + scrollback
  "What was that Claude session id?" → History page grouped by project + cwd
  "Which agent finished?"        →    Active / idle detection + idle notifications
  "What files changed?"          →    Git sidebar diff
  "Just fix this yaml"           →    File tree → save, no IDE
```

→ Workflow details: [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) (Chinese)

## How it compares

omas **does not replace** Cursor / VS Code / Claude Desktop — deep refactors, large-project navigation, and chat reasoning stay in the IDE. omas handles the lightweight slice: **agent running, shell working, changes need a quick look.**

### vs. editors & agent clients

| | Cursor / VS Code | Claude Desktop, etc. | ttyd / gotty | **omas** |
|---|------------------|----------------------|--------------|----------|
| Main UI | Editor + sidebar + chat | Chat | Single terminal | **Terminal-centered** |
| Cognitive load | High (full IDE) | Medium (chat-first) | Low (no AI context) | **Low with AI context** |
| Multiple agents / tasks | Many windows/tabs, easy to mix up | Multiple threads | DIY | **Session list + project grouping** |
| Close frontend tab | Depends on product | Cloud/local chat | Process may die | **Background PTY continues** (service) |
| AI history resume | Built-in agent panel | Built-in | None | **Scan CLI jsonl, one-click resume** |
| Review AI changes | Full SCM / diff | Limited | None | **Git sidebar diff + light edit** |
| Edit small files | Full IDE | Often unsupported | None | **Sidebar CodeMirror is enough** |
| Remote / iPad | Port forwarding | Varies | Yes | **Browser + single self-hosted binary** |

**In short:** the IDE is for thinking and writing large code; omas is for running, watching, reviewing changes, and resuming agents.

### vs. CLI + tmux

Many people run **SSH → tmux → Claude/Cursor CLI** for long agents. tmux persistence is excellent, but **scrolling history and copying output fight each other**: mouse mode scrolls the copy-buffer, copying needs copy-mode (`Ctrl+b [`), and both clash with TUI mouse events. omas puts PTY output in xterm.js and **delegates scroll/copy to the browser** — easier to grep logs, copy errors, and paste into issues during long runs.

| | CLI + tmux | **omas** |
|---|------------|----------|
| Persistence | ✅ After `detach` | ✅ Background service + server PTY |
| Mouse-wheel scrollback | ⚠️ Needs `mouse on`; scrolls copy-buffer | ✅ Native browser scrollback |
| Copy text | ⚠️ Often copy-mode, conflicts with mouse mode | ✅ Drag select + `Cmd/Ctrl+C` |
| Tell agents apart | Window names / `list-sessions` | ✅ Session list + grouping + history resume |
| Edit files / diff | Another editor or `split` | ✅ File tree + Git panel |

omas is **not** a tmux replacement for pane layout or minimal SSH-only setups. It fits **agent workflows + frequent scroll/copy + occasional remote check-ins**.

## Documentation

| Doc | Contents |
|-----|----------|
| [README.en.md](./README.en.md) | This file — product overview in English |
| [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) | Workflow, IDE/tmux split, history resume (Chinese) |
| [docs/MANUAL.md](./docs/MANUAL.md) | Commands, config, API, public sites, deploy, troubleshooting (Chinese) |
| [DEPLOY.md](./DEPLOY.md) | Reverse proxy, WebSocket, HTTPS |
| [CHANGELOG.md](./CHANGELOG.md) | Release notes |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | Development |
| [SECURITY.md](./SECURITY.md) | Threat model & vulnerability reports |

## Development

```bash
OMAS_PASSWORD=devpass npm run dev:server   # :7681
npm run dev:web                            # :5173
npm test && npm run typecheck
```

## Naming

| Name | Meaning |
|------|---------|
| **omas** | Product name, CLI command, and GitHub repo [`lilymoonight/omas`](https://github.com/lilymoonight/omas); **abbreviation of `oh-my-agent-shell`** (**o**h-**m**y-**a**gent-**s**hell) |
| **oh-my-agent-shell** | Full project name; still used for the npm package and default config dir (`~/.config/oh-my-agent-shell`) |

## License

[MIT](./LICENSE) © lily
