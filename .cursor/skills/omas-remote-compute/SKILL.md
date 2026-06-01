---
name: omas-remote-compute
description: >-
  Run shell commands and move files on a remote host through an omas server
  using the `omas exec`, `omas upload`, and `omas download` CLIs ("session as
  workspace" model). Use when offloading compute to a machine running omas —
  building / testing / running code remotely, uploading inputs, or downloading
  results — or when the user mentions omas, `omas exec`, a remote workspace, or a
  sandboxed remote session.
---

# omas remote compute (exec / upload / download)

Treat a remote omas host as disposable compute. A **workspace** is just a real
directory on that host. `upload → exec → download` pointing at the same
directory share files.

## Prerequisites

- `omas` on PATH locally (same binary as the server).
- The server URL. Scheme defaults to `https`; use `http://…` for localhost and
  add `--insecure` for self‑signed TLS.
- Login password via `--password`, `OMAS_PASSWORD`, or interactive prompt. Omit
  entirely if the server runs password‑free.

## The three commands

```bash
# Run a command in the workspace; exit code mirrors the remote command.
omas exec <url> --cwd <workspace> -- <command...>

# Upload a local file into the workspace (auto-chunks large files).
omas upload <url> <localFile> [remoteSubdir] --cwd <workspace>

# Download a file (or a directory as .tar.gz) from the workspace.
omas download <url> <remoteRelPath> [localPath] --cwd <workspace>
```

Always put `--` before the exec command so its flags aren't parsed by omas.

## Choosing the workspace

- `--cwd <dir>`: spins up an **ephemeral session** for this one call, then
  destroys it. **Files written to the directory persist on disk** — only the
  session is temporary. Use the same `--cwd` across calls to share files.
- `-s <sessionId>`: reuse an **existing session** (shared with the web UI). Use
  this to keep one long‑lived workspace across many calls.

## Sandbox

If the server was started with `--sandbox-root <root>`, sessions are sandboxed
by default: **the whole filesystem is read‑only except the workspace `cwd`**,
which must live inside `<root>`. `omas exec` runs under the same confinement.

- Keep `--cwd` inside the sandbox root, or creation fails with
  `cwd_outside_sandbox_root`.
- For full read‑write (no sandbox): `--no-sandbox --bypass <pw>` (or
  `OMAS_BYPASS`). The bypass password is separate from the login password and
  must be configured server‑side; without it, non‑sandbox sessions are refused.

## exec details

- `--timeout <ms>`: default `120000`, max `3600000`. Long builds need a higher
  value.
- Returns the remote command's stdout/stderr and **exit code** (the local
  `omas exec` process exits with the same code) — branch on it like any command.
- Stateless: each `exec` is a fresh `sh -c <command>`, not the live shell. Chain
  steps in one command (`a && b`) or use `-s` to reuse a session's directory.

## download details

- A directory is streamed as `.tar.gz`; name the local target accordingly.
- Local path `-` writes to stdout (pipe it).

## Typical agent workflow

```bash
URL=https://box.example.com
WS=/srv/agent/job1            # inside sandbox-root if sandboxed

omas upload  $URL ./main.py        --cwd $WS
omas upload  $URL ./requirements.txt --cwd $WS
omas exec    $URL --cwd $WS --timeout 600000 -- \
  "pip install -r requirements.txt && python main.py > out.log 2>&1"
omas download $URL out.log ./out.log --cwd $WS
omas download $URL results/ ./results.tar.gz --cwd $WS   # directory → tar.gz
```

## Examples

```bash
# One-off command, local server, password via env.
OMAS_PASSWORD=secret omas exec http://127.0.0.1:7681 --cwd /tmp/w -- ls -la

# Reuse a long-lived session by id.
omas exec $URL -s 7Qz... -- "make test"

# Full write access (bypass sandbox).
omas exec $URL --cwd /data/scratch --no-sandbox --bypass "$OMAS_BYPASS" -- ./setup.sh
```
