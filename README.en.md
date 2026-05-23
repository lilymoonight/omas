# omas

**中文：** [README.md](./README.md)

> Too much context in the agent era. **omas splits each task into its own session** — terminal-first, disposable browser tabs, agents keep running in the background; local AI history is scanned automatically so you can resume anytime.

A self-hosted web terminal for AI-assisted development. Not an agent, not an IDE replacement — a **lightweight shell console that reduces memory load**: the main view is the terminal; side panels cover just enough file editing and AI diff review.

[![Release](https://img.shields.io/github/v/release/lilymoonight/omas)](https://github.com/lilymoonight/omas/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Core idea: keep context light

When you juggle Claude, Cursor, three repos, and five agents at once, **the hard part is not running commands — it is remembering which window is doing what**.

| Pain | How omas helps |
|------|----------------|
| Chat, terminal, diff, and file tree stacked in one editor | **Terminal is the main page** — single visual focus |
| Every task mixed in one window | **One session per task** — clear at a glance in the list |
| Closing a tab = losing context? | **PTY keeps running in omas** — closing the browser tab only disconnects the view; refresh to reconnect |
| Small file edits force you to open an IDE | **Click-to-edit in the sidebar** (CodeMirror) — no app switch |
| Agent changed many files — hard to review | **Git panel for centralized review** — diff, light edit, or `$EDITOR` in the terminal |
| Where did yesterday's agent stop? | **Auto-scan** Claude / Cursor / Qoder / OpenCode **local history**, one-click `--resume` |

```text
  Your brain                         What omas remembers
  ─────────                          ────────────────────
  "Agent is running tests here"  →   Session list + scrollback
  "What was that Claude session id?" → History page grouped by project + cwd
  "What files changed?"          →   Git sidebar diff
  "Just fix this yaml"           →   File tree → save, no IDE
```

## vs. editors & agent clients

omas **does not replace** Cursor, VS Code, or Claude Desktop — deep refactors, large-project navigation, and chat reasoning stay in the IDE. omas handles **“agent running, shell working, changes need a quick look”** — the lightweight slice.

| | Cursor / VS Code | Claude Desktop, etc. | ttyd / gotty | **omas** |
|---|------------------|----------------------|--------------|----------|
| Main UI | Editor + sidebar + chat | Chat | Single terminal | **Terminal-centered** |
| Cognitive load | High (full IDE) | Medium (chat-first) | Low (no AI context) | **Low with AI context** |
| Multiple agents / tasks | Many windows/tabs, easy to mix up | Multiple threads | DIY | **Session list separates tasks** |
| Close frontend tab | Depends on product | Cloud/local chat | Process may die | **Background PTY continues** (omas service) |
| AI history resume | Built-in agent panel | Built-in | None | **Scan CLI jsonl, one-click resume** |
| Review AI changes | Full SCM / diff | Limited | None | **Git sidebar diff + light edit** |
| Edit small files | Full IDE | Often unsupported | None | **Sidebar CodeMirror is enough** |
| Remote / iPad | Port forwarding | Varies | Yes | **Browser + single self-hosted binary** |

**In short:** the IDE is for thinking and writing large code; omas is for running, watching, reviewing changes, and resuming agents — without stuffing all context into one editor window.

## vs. CLI + tmux

Many people run **SSH → tmux → Claude/Cursor CLI** for long agents. tmux session persistence is excellent, but **scrolling history and copying output** fight each other — omas uses browser + xterm.js to avoid that friction.

| | CLI + tmux | **omas** |
|---|------------|----------|
| Session persistence | ✅ After `detach` | ✅ Background service + server PTY |
| Mouse wheel scrollback | ⚠️ Needs `mouse on`; scrolls **tmux copy buffer**, not intuitive “scroll the terminal” | ✅ Native browser scrollback |
| Copy text | ⚠️ Often **copy-mode** (`Ctrl+b [`), vi keys; conflicts with mouse mode | ✅ **Drag select + Cmd/Ctrl+C** like the web |
| mouse on + TUI agents | ⚠️ Wheel may be captured by tmux; mouse + copy-mode clash | ✅ xterm + TUI coexist; copy uses browser selection |
| Tell agents apart | Window names / `tmux list-sessions` | ✅ Session list + **AI history page** |
| Edit files / diff | Another editor or `tmux split` | ✅ File tree + Git panel |
| Remote | SSH | Browser (SSH tunnel / port forward) |

**The tmux tension:** natural mouse scrolling often requires mouse mode, but **copy** still relies on copy-mode and fights TUI mouse events. omas puts PTY output in xterm.js and delegates scroll/copy to the browser — easier to grep logs, copy errors, and paste into issues during long agent runs.

omas is **not** a tmux replacement for pane layout or minimal SSH-only setups. It fits **agent workflows + frequent scroll/copy + occasional remote check-ins**.

## Typical workflow: disposable tabs

```text
┌──────────┬──────────────────────────────┬──────────┐
│ Files    │  ■ Session A  claude --resume │ Git diff │
│ edit env │  ■ Session B  npm test        │ review   │
│          │  ■ Session C  tail -f log       │ AI edits │
└──────────┴──────────────────────────────┴──────────┘
     ↑ light edit              ↑ main stage        ↑ glance before merge
```

1. **History resume** — scan local AI CLI sessions, group by project; click resume → new tab, auto `cd` + `--resume`.
2. **One session per task** — long agent in one session; open another for logs; **closing the tab does not kill the agent**.
3. **Review before merge** — Git panel for agent changes; small fixes in sidebar, large ones via `$EDITOR` or back to the IDE.
4. **Leave when done** — close the browser tab; context stays in omas session list and history — **no need to keep the IDE workspace occupied**.

→ Details: [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) (Chinese; English summary in this file)

## How is this different from ttyd?

ttyd / gotty are **generic web terminals**. omas adds **agent-era session management**:

- Multi-session list, reconnect, scrollback
- Claude / Cursor / Qoder / OpenCode **history scan & resume**
- File tree + Git sidebar (enough, not an IDE)
- Single `omas` binary, four-architecture releases

## Quick start

**Download a binary** (recommended): [Releases](https://github.com/lilymoonight/omas/releases) — pick `omas-*`, or:

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

## Documentation

| Doc | Contents |
|-----|----------|
| [README.en.md](./README.en.md) | This file — product overview in English |
| [docs/AI-WORKFLOW.md](./docs/AI-WORKFLOW.md) | Workflow, IDE/tmux split, history resume (Chinese) |
| [docs/MANUAL.md](./docs/MANUAL.md) | Commands, config, API, deploy, troubleshooting (Chinese) |
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
| **omas** | Product name, CLI command, GitHub repo [`lilymoonight/omas`](https://github.com/lilymoonight/omas) |
| **oh-my-agent-shell** | npm package name (legacy) |

## License

[MIT](./LICENSE) © lily
