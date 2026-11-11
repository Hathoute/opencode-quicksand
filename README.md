# opencode-quicksand

(Fully vibecoded, proof of concept - Skip this project)

Runs [opencode](https://github.com/anomalyco/opencode) with every tool execution
inside a [quicksand](https://github.com/microsoft/quicksand) VM: the agent's
Read/Write/Patch/Shell tools execute over SSH in an Ubuntu sandbox while the
session, config discovery, and the mounted `data/` directory stay on the host.

## Layout

| Path | Purpose |
|------|---------|
| `config.jsonc` | runtime paths, OpenCode checkout tag/port, and sandbox initialization settings |
| `bin/run_opencode` | PATH-friendly launcher; bootstraps per-user state and mounts the current directory |
| `run-template/sandbox/` | tracked guest image lifecycle (`init.sh` + its `init/` mount) |
| `run-template/opencode/` | tracked host OpenCode lifecycle (`init.sh`; future MCP services) |
| `opencode/` | opencode poc TypeScript sources: SSH workspace driver (`driver.ts` + per-platform adapters), embedder (`embed.ts`), streaming test (`stream-test.ts`) |
| `quicksand/` | VM launcher and runtime SSH keys |
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
- `config.jsonc` pointing to an OpenCode config directory, writable cache
  directory, and sandbox init script; the OpenCode `opencode.jsonc` should set
  `"shell": "bash"` for the guest
- a runtime directory; `run_opencode` creates it automatically, while direct
  repository scripts use `cp -R run-template run` once

## Quickstart

With this repository's `bin/` on `PATH`, launch from the directory that should
be mounted at `/data`:

```bash
cd /path/to/your/workspace
run_opencode
```

On first use the launcher copies `config.jsonc` and `run-template/` to
`~/.opencode-quicksand/`. Every start runs the sandbox lifecycle, replaces the
tagged image, starts a persistent host Bash from `opencode.initScript`, and then
starts the embedder. CTRL+C stops the embedder, exits the OpenCode init Bash,
and closes the sandbox.

The individual repository scripts remain available for development:

Run steps 1 and 2 together with `bun run start:opencode`. Pressing CTRL+C stops
the embedder first and then closes the sandbox gracefully.

```bash
# one-time runtime setup (run/ is gitignored)
cp -R run-template run

# optional: apply init.sh, replace the tagged image, then exit
bun run init:sandbox

# 1) apply init.sh, replace the tagged image, and start the VM
bun run start:sandbox

# 2) host OpenCode lifecycle (starts the configured Supergateway)
source run/opencode/init.sh

# 3) opencode embedder on the configured opencode.port (first run: clone + bun install)
bun run start:embed

# 4) drive the configured model — every command runs inside the VM
opencode run --server http://localhost:14096 --auto \
  "Run the shell command: hostname && uname -a && head -5 /data/README.md"
```

The same commands work in PowerShell; no runtime environment variables are
required.

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
  same plugin upstream uses. Reads `config.jsonc` from its start directory by
  default; pass `--config <file>` to use another file.
- `sandbox-*` (slim folder + zip): PyInstaller **onedir** with interpreter +
  deps + QEMU binaries, built in the uv-managed `build` dependency-group. The
  VM base image is **not** bundled — provide it via `sandbox.image` (a qcow2
  path, or a provider name whose fat wheel is installed; see config table).
  PyInstaller cannot cross-compile — build on the target platform (CI does).
  Reads `config.jsonc` from its start directory by default; pass `--config
  <file>`. Every normal run updates the tagged image; `--init` performs the
  same update and exits instead of holding the VM open. The VM mounts the
  current working directory at `/data`. Nothing extracts to the temp dir at
  runtime (onedir executes in place, so machines whose policy blocks
  executing from `%TEMP%` — WinError 1260 — work too).

## Scripts

| Command | What it does |
|---------|--------------|
| `bun run init:sandbox` | runs the init lifecycle, atomically replaces `<sandbox.image>-<sandbox.imageTag>`, then exits |
| `bun run start:opencode` | updates and starts the sandbox, runs the persistent OpenCode init shell, then starts the embedder; CTRL+C stops all three in reverse order |
| `bun run start:sandbox` | starts from the tagged image or a fresh base, runs init, replaces the image, then holds the VM open |
| `bun run start:embed` | fetches `opencode.tag`, syncs `opencode/*.ts` → `build/opencode/poc`, installs dependencies, and starts the embedder |
| `bun run build:embed` | compiles `embed-<target>` for `EMBED_TARGET` (windows-x64, linux-x64, linux-arm64; default: host) |
| `bun run build:sandbox` | `uv sync --frozen --group build`, warm the quicksand fat wheels from the quicksand index, then PyInstaller **onedir** as `sandbox-<os>-<arch>/` + `sandbox-<os>-<arch>.zip` |
| `bun run build:all` | both (host target) |

## Configuration

Paths in `config.jsonc` are resolved relative to that file. `run_opencode`
loads `~/.opencode-quicksand/config.jsonc`; repository scripts default to the
root config and also accept `--config <file>`.
The checked-in configuration points at the gitignored `run/` directory; create
it from `run-template/` before first use. Runtime databases and local config
changes therefore stay untracked while the complete starting layout remains
versioned.

| Key | Purpose |
|-----|---------|
| `opencode.configDir` | directory containing OpenCode's `opencode.jsonc` |
| `opencode.cacheDir` | persistent embedder state (`opencode.db`) |
| `opencode.initScript` | host Bash lifecycle sourced before the embedder starts and exited during shutdown |
| `opencode.tag` | Git tag, branch, or commit fetched for the pinned checkout |
| `opencode.port` | embedder HTTP port |
| `sandbox.image` | Quicksand base image provider name (`ubuntu`, `alpine`, `ubuntu-desktop`, …; provider must be installed) **or a path to a base `*.qcow2`** with sibling `*.kernel`/`*.initrd` files — the layout of a fat wheel extracted from [quicksand's simple index](https://microsoft.github.io/quicksand/simple/). Relative paths resolve against `config.jsonc`; the file stem becomes the image label |
| `sandbox.imageTag` | persistent image tag; the save is `<image name>-<sandbox.imageTag>` (default `default`) — provider form `ubuntu-default`, path form `ubuntu-24.04-amd64-default` |
| `sandbox.cpus` | number of virtual CPUs (positive integer; default `1`) |
| `sandbox.memory` | guest memory size accepted by Quicksand (default `512M`) |
| `sandbox.diskSize` | guest disk size accepted by Quicksand (default `10G`) |
| `sandbox.enableDisplay` | enable the QEMU display, VNC endpoint, and host screenshot (default `false`; use with a desktop image) |
| `sandbox.initScript` | idempotent bash lifecycle script executed before every sandbox becomes ready |
| `sandbox.cacheDir` | directory containing tagged sandbox images and runtime port files |
| `sandbox.mounts` | additional host/guest directory mounts; relative host paths resolve from `config.jsonc` and are created automatically |
| `sandbox.env` | default environment variables injected into every SSH-routed tool command |
| `sandbox.portMapping` | list of non-SSH Quicksand forwards such as `{ "from": "Host(8080)", "to": "Guest(8080)" }`; SSH automatically uses the first free host port from `52222` |

The directory where `run_opencode` is invoked is always mounted at `/data` and
used as the OpenCode workspace.

Whenever the sandbox starts, the directory named `init` beside
`sandbox.initScript` is mounted at `/mnt/init`. It is a host mount and is **not**
persisted in the saved image; the script must copy anything it needs to retain
onto the guest filesystem. Additional `sandbox.mounts` are likewise not
persisted.

The script receives `SANDBOX_LIFECYCLE=create` when the tagged image does not
exist and `SANDBOX_LIFECYCLE=update` when it does, plus
`SANDBOX_IMAGE_TYPE` and `SANDBOX_IMAGE_TAG`. It must support repeated `update`
runs. A failed lifecycle keeps the previous valid image; a successful run is
flattened and atomically replaces it. Provisioning stops before the swap, and
all temporary update/previous images are removed before the runtime VM boots;
only `<sandbox.image>-<sandbox.imageTag>` remains in `sandbox.cacheDir`.

`opencode.initScript` is sourced into a persistent host Bash after the sandbox
is ready. The embedder starts only after that script succeeds. During shutdown,
the launcher writes `exit` to the Bash and waits, allowing future MCP server
cleanup registered with `trap ... EXIT` to run. The default script starts
`supergateway@4.2.2` from `run/opencode/mcp-gateway.json` after sourcing
`run/opencode/.env`; the template exposes a GitLab MCP endpoint at
`http://127.0.0.1:18080/gitlab/mcp`. The template `.env` contains no secrets;
set `GITLAB_PERSONAL_ACCESS_TOKEN` in the ignored runtime copy before starting.

The default init script installs Podman with rootless dependencies and creates
`podmanuser` with subordinate UID/GID ranges, lingering, and a persistent
runtime-directory rule. Run rootless commands with, for example,
`runuser -l podmanuser -c 'podman info'`.

`EMBED_TARGET` remains an optional build-only override for cross-compilation.

With `sandbox.enableDisplay: true`, startup prints the loopback-only VNC URL,
writes its port to `<sandbox.cacheDir>/vnc-port`, and captures
`<sandbox.cacheDir>/desktop.png`. Connect with TigerVNC using its explicit-port
syntax (two colons):

```bash
vncviewer "127.0.0.1::$(cat ~/.opencode-quicksand/.quicksand/sandboxes/vnc-port)"
```

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
