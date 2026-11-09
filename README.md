# opencode-quicksand

Runs [opencode](https://github.com/anomalyco/opencode) with every tool execution
inside a [quicksand](https://github.com/microsoft/quicksand) VM: the agent's
Read/Write/Patch/Shell tools execute over SSH in an Ubuntu sandbox while the
session, config discovery, and the mounted `data/` directory stay on the host.

## Layout

| Path | Purpose |
|------|---------|
| `opencode/` | opencode poc TypeScript sources: SSH workspace driver (`driver.ts` + per-platform adapters), embedder (`embed.ts`), streaming test (`stream-test.ts`) |
| `quicksand/` | `sandbox.py` (VM launcher) + runtime state created on boot (`ssh/` keys, `.venv`) |
| `build/` | CI-friendly build/run scripts (`build/*.ts`), the pinned opencode checkout (`build/opencode`), compiled executables (`build/dist`) |
| `TESTING.md` | step-by-step verification workflows |
| `FINDINGS.md` | root causes discovered while building this (Windows guestfwd, in-memory DB auth, stdin wiring, Bun idleTimeout, frozen-mode pitfalls, …) |

## Prerequisites

- [bun](https://bun.sh) (runs all scripts; `winget install Oven-sh.Bun`)
- python ≥ 3.11 on PATH (or `$PYTHON`) — the sandbox venv bootstraps itself
- git, and Windows OpenSSH client (`ssh`, `ssh-keygen`) on PATH
- `opencode` CLI on PATH (for `opencode run` testing)
- a Z.AI Coding Plan API key (`ZAI_API_KEY`)

## Quickstart (three terminals)

```powershell
# 1) sandbox VM: sshd on 127.0.0.1:2222, YOUR CURRENT DIRECTORY mounted at /data
bun run start:sandbox

# 2) opencode embedder on http://localhost:4096 (first run: clone + bun install)
$env:ZAI_API_KEY = "<key>"
bun run start:embed

# 3) drive the agent — every command runs inside the VM
opencode run --server http://localhost:4096 --auto -m zai-coding-plan/glm-5.3-flash `
  "Run the shell command: hostname && uname -a && head -5 /data/README.md"
```

## Packaging (standalone executables)

```powershell
bun run build:embed     # → build/dist/embed.exe    (~158 MB)
bun run build:sandbox   # → build/dist/sandbox.exe  (~351 MB)
bun run build:all       # both
```

- `embed.exe` needs only env vars: `PORT`, `SSH_KEY`, `ZAI_API_KEY`,
  `WORKSPACE_HOST_DIR`, optional `SSH_DRIVER_LOG` (see FINDINGS.md #1)
- `sandbox.exe` creates `ssh\` next to itself; the VM mounts the directory the
  exe is STARTED FROM at `/data` (`SANDBOX_MOUNT_DIR` overrides). Needs Windows
  OpenSSH client on PATH. First start extracts the archive to %TEMP% (~10–20 s)

## Scripts

| Command | What it does |
|---------|--------------|
| `bun run start:sandbox` | bootstraps `quicksand/.venv`, boots the VM (interactive: Enter stops; CI: 5-min hold) |
| `bun run start:embed` | fetches the opencode checkout at the pinned commit (`OPENCODE_COMMIT` or default), syncs `opencode/*.ts` → `build/opencode/poc`, `bun install`, starts the embedder |
| `bun run build:embed` | compiles `embed.exe` (pty binary embedded, wasm scanner stubbed) |
| `bun run build:sandbox` | PyInstaller onefile with image + QEMU binaries + dist metadata |
| `bun run build:all` | both exes |

## Environment

| Variable | Default | Used by |
|----------|---------|---------|
| `ZAI_API_KEY` | — | embedder (in-memory DB ⇒ auth via config) |
| `SANDBOX_MOUNT_DIR` | caller's CWD | sandbox: host directory mounted at `/data` |
| `OPENCODE_COMMIT` | `ced73dc0…` (pinned) | checkout pin; falls back to the sibling `../opencode` checkout's HEAD when present |
| `PORT` / `SSH_HOST` / `SSH_PORT` / `SSH_KEY` / `WORKSPACE_HOST_DIR` | 4096 / localhost / 2222 / `quicksand/ssh/quicksand_demo` / caller's CWD | embedder (workspace dir must match the sandbox mount) |
| `SSH_DRIVER_LOG` | unset | `1` traces every ssh invocation from the driver |
| `PYTHON` | `python` | interpreter used to bootstrap the sandbox venv |

## CI

All scripts are plain `bun build/*.ts` invocations — a workflow needs
`oven-sh/setup-bun`, `actions/setup-python`, git, and the `ZAI_API_KEY` secret,
then calls `bun run build:all` / `bun run start:*`. No PowerShell required.
