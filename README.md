# opencode-quicksand

Runs [opencode](https://github.com/anomalyco/opencode) with every tool execution
inside a [quicksand](https://github.com/microsoft/quicksand) VM: the agent's
Read/Write/Patch/Shell tools execute over SSH in an Ubuntu sandbox while the
session, config discovery, and the mounted `data/` directory stay on the host.

## Layout

| Path | Purpose |
|------|---------|
| `opencode/` | opencode poc TypeScript sources: SSH workspace driver (`driver.ts` + per-platform adapters), embedder (`embed.ts`), streaming test (`stream-test.ts`) |
| `quicksand/` | `sandbox.py` (VM launcher) + runtime state created on boot (`ssh/` keys) |
| `build/` | CI-friendly build/run scripts (`build/*.ts`), the pinned opencode checkout (`build/opencode`), compiled executables (`build/dist`) |
| `pyproject.toml` + `uv.lock` | uv-managed Python tooling (quicksand, PyInstaller); interpreter pinned via `.python-version` |
| `TESTING.md` | step-by-step verification workflows |
| `FINDINGS.md` | root causes discovered while building this (Windows guestfwd, in-memory DB auth, stdin wiring, Bun idleTimeout, frozen-mode pitfalls, …) |

## Prerequisites

- [bun](https://bun.sh) (runs all scripts; `winget install Oven-sh.Bun` /
  `curl -fsSL https://bun.sh/install | bash` / `brew install bun`)
- [uv](https://docs.astral.sh/uv/) — manages Python itself: the interpreter
  (`.python-version`), the environment (`.venv`) and every Python dependency
  (`uv.lock`). No system Python or pip needed. Install:
  `curl -LsSf https://astral.sh/uv/install.sh | sh` /
  `winget install --id=astral-sh.uv` / `brew install uv`
- git, and an OpenSSH client (`ssh`, `ssh-keygen`, `ssh-keyscan`) on PATH
- the `opencode` CLI on PATH (for `opencode run` testing)
- a Z.AI Coding Plan API key (`ZAI_API_KEY`)

## Quickstart (three terminals)

```bash
# 1) sandbox VM: sshd on 127.0.0.1:2222, YOUR CURRENT DIRECTORY mounted at /data
bun run start:sandbox

# 2) opencode embedder on http://localhost:4096 (first run: clone + bun install)
export ZAI_API_KEY="<key>"
bun run start:embed

# 3) drive the agent — every command runs inside the VM
opencode run --server http://localhost:4096 --auto -m zai-coding-plan/glm-5.3-flash \
  "Run the shell command: hostname && uname -a && head -5 /data/README.md"
```

(Windows: `$env:ZAI_API_KEY = "<key>"` and backtick line continuations — see
TESTING.md for per-shell variants and the host-platform support table.)

## Packaging (standalone executables)

```bash
bun run build:embed                          # → build/dist/embed-<os>-<arch>[.exe]
EMBED_TARGET=windows-x64 bun run build:embed # cross-compiles from any host
bun run build:sandbox                        # → build/dist/sandbox-<os>-<arch>[.exe]
bun run build:all
```

- `embed-*` (~140-160 MB): plain `bun build --compile` — source embedded, JIT
  at runtime (`bytecode: true` compiles but yields a silent no-op executable
  on Bun 1.4.4, and machine-code AOT cannot cross-compile; notes in
  `build/build-embed-exe.ts`). Cross-compiles every target from one host; the
  pty binary of the *target* platform is force-installed and embedded via the
  same plugin upstream uses. Needs env vars:
  `PORT`, `SSH_KEY`, `ZAI_API_KEY`, `WORKSPACE_HOST_DIR`, optional
  `SSH_DRIVER_LOG`.
- `sandbox-*` (~330 MB): PyInstaller onefile with interpreter + deps + Ubuntu
  image + QEMU binaries, built in the uv-managed `build` dependency-group.
  PyInstaller cannot cross-compile — build on the target platform (CI does).
  Creates `ssh/` next to itself; the VM mounts the directory the exe is
  STARTED FROM at `/data` (`SANDBOX_MOUNT_DIR` overrides). First start
  extracts the archive to the temp dir (~10-20 s).

## Scripts

| Command | What it does |
|---------|--------------|
| `bun run start:sandbox` | `uv sync --frozen` (creates `.venv`, downloads the pinned interpreter on first run), boots the VM (interactive: Enter stops; CI: 5-min hold) |
| `bun run start:embed` | fetches the opencode checkout at the pinned commit (`OPENCODE_COMMIT` or default), syncs `opencode/*.ts` → `build/opencode/poc`, `bun install`, starts the embedder |
| `bun run build:embed` | compiles `embed-<target>` for `EMBED_TARGET` (windows-x64, linux-x64, linux-arm64; default: host) |
| `bun run build:sandbox` | `uv sync --frozen --group build`, then PyInstaller onefile as `sandbox-<os>-<arch>` |
| `bun run build:all` | both (host target) |

## Environment

| Variable | Default | Used by |
|----------|---------|---------|
| `ZAI_API_KEY` | — | embedder (in-memory DB ⇒ auth via config) |
| `SANDBOX_MOUNT_DIR` | caller's CWD | sandbox: host directory mounted at `/data` |
| `OPENCODE_COMMIT` | `ced73dc0…` (pinned) | checkout pin; falls back to the sibling `../opencode` checkout's HEAD when present |
| `EMBED_TARGET` | host platform | `build:embed` cross-compile target |
| `PORT` / `SSH_HOST` / `SSH_PORT` / `SSH_KEY` / `WORKSPACE_HOST_DIR` | 4096 / localhost / 2222 / `quicksand/ssh/quicksand_demo` / caller's CWD | embedder (workspace dir must match the sandbox mount) |
| `SSH_DRIVER_LOG` | unset | `1` traces every ssh invocation from the driver |

## CI / releases

`.github/workflows/release.yml` — push a `v*` tag to build everything and open
a **draft GitHub Release** with all binaries + checksums, or run it via
`workflow_dispatch` to produce artifacts only:

- `embed` job: one Linux runner cross-compiles `embed-windows-x64.exe`,
  `embed-linux-x64`, `embed-linux-arm64`, `embed-macos-arm64`
- `sandbox` job: native runners (`windows-latest`, `ubuntu-latest`,
  `ubuntu-24.04-arm`, `macos-15`) build `sandbox-<os>-<arch>` with `setup-uv`
  caching the ~400 MB quicksand wheels

macOS arm64 release binaries are built in CI but have not yet been exercised
on Apple hardware.

Note: quicksand's PyPI packages are stubs for its fat image/QEMU wheels — at
first boot quicksand upgrades them from its own index via `python -m pip`,
which is why `pip` is a declared dependency in `pyproject.toml` (uv
environments ship without it). Details in FINDINGS.md #16.
