# USAGE

Run opencode with every agent tool execution inside a quicksand VM, using the
two standalone binaries — no repository checkout needed at runtime:

| Binary | Role |
|--------|------|
| `sandbox-<os>-<arch>[.exe]` | boots the Ubuntu VM (QEMU): provisions it, mounts your current directory at `/data`, exposes SSH |
| `embed-<os>-<arch>[.exe]` | the opencode embedder: an SDK server that places every session into the VM over SSH |

Both read the same `config.jsonc`. The VM's SSH port is allocated automatically
(first free loopback port from 52222) and published for the embedder.

## Prerequisites

- An OpenSSH client on PATH: `ssh`, `ssh-keygen`, `ssh-keyscan`
  - Windows: the "OpenSSH Client" optional capability
  - Linux: `openssh-client` · macOS: built in
- The `opencode` CLI on PATH (to drive the agent)
- A model provider API key (configured in `opencode.jsonc`, see below)
- ~2 GB disk for the VM image, ~2 GB RAM for the VM

## 1. Get the binaries

### Option A — download from a release

Draft releases are published on GitHub for every `v*` tag:
<https://github.com/Hathoute/opencode-quicksand/releases>

Each release contains (plus `checksums.txt`):

```
embed-windows-x64.exe     embed-linux-x64     embed-linux-arm64     embed-macos-arm64
sandbox-windows-x64.zip   sandbox-linux-x64.zip sandbox-linux-arm64.zip sandbox-macos-arm64.zip
```

The sandbox ships as a **directory in a zip** (interpreter + Ubuntu image +
QEMU binaries — nothing is extracted to `%TEMP%` at runtime, so it also works
on machines whose policy blocks executing from temp, WinError 1260). Pick the
pair matching your platform, extract the zip anywhere.

### Option B — build from source

Needs [bun](https://bun.sh) and, for the sandbox only, [uv](https://docs.astral.sh/uv/) (it manages
Python + PyInstaller itself; no system Python needed) and git:

```bash
git clone https://github.com/Hathoute/opencode-quicksand.git
cd opencode-quicksand

bun run build:embed     # → build/dist/embed-<current-platform>[.exe]
bun run build:sandbox   # → build/dist/sandbox-<current-platform>[.exe]
```

`build:embed` cross-compiles: set `EMBED_TARGET=windows-x64|linux-x64|linux-arm64|macos-arm64`
(or pass it as the first argument) to build for another platform.
`build:sandbox` cannot cross-compile (PyInstaller) — build it on the target OS.

## 2. Set up `config.jsonc`

Both binaries resolve `config.jsonc` from their working directory by default;
pass `--config <file>` for anything else. All paths inside the config resolve
relative to the config file itself (`~` is supported).

```jsonc
{
  // ── opencode embedder ────────────────────────────────────────────────
  "opencode": {
    // Directory with your opencode.jsonc: provider auth (API key), default
    // model, and `"shell": "bash"` (the guest is Linux). This is where the
    // embedder reads credentials from.
    "configDir": "./run/config",
    // Persistent embedder state (SQLite database).
    "cacheDir": "./run/cache",
    // opencode commit the SOURCE build runs against. Required but unused by
    // the prebuilt embed binary.
    "tag": "ced73dc0f6c5b00c3a085b1d7b11ea31f790c5df",
    // Port the embedder listens on.
    "port": 14096
  },
  // ── sandbox VM ───────────────────────────────────────────────────────
  "sandbox": {
    "image": "ubuntu",        // base image
    "imageTag": "default",    // saved as ubuntu-default
    "cpus": 1,
    "memory": "512M",
    "diskSize": "10G",        // sparse qcow2
    "enableDisplay": false,   // true + TigerVNC viewer = see the VM desktop
    // Idempotent guest lifecycle run before every start (apt installs etc.).
    // SANDBOX_LIFECYCLE is "create" or "update".
    // Keep it LF-ended; CRLF breaks bash on the guest.
    "initScript": "./run/init.sh",
    // Image storage + the published ssh-port file.
    "cacheDir": "./.quicksand/sandboxes",
    // Extra host→guest mounts (CWD is always mounted at /data; reserved).
    "mounts": [
      { "host": "./cache/.m2", "guest": "/root/.m2" }
    ],
    // Environment variables injected into every guest command.
    "env": {
      "MAVEN_OPTS": "-Dmaven.repo.local=/root/.m2"
    },
    // Extra port forwards; SSH is forwarded automatically.
    "portMapping": [
      { "from": "Host(8080)", "to": "Guest(8080)" }
    ]
  }
}
```

Also create the embedder's config directory with an `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "update": "disable",
  "shell": "bash",
  "model": "zai-coding-plan/glm-5.3-flash",
  "provider": {
    "zai-coding-plan": {
      "options": { "apiKey": "<your key>" }
    }
  }
}
```

A tracked template for the runtime tree lives in `run-template/` (repository
checkouts): copy it once and edit — `run/` is gitignored.

## 3. Run `sandbox-*`

Extract the zip (`sandbox-<os>-<arch>.zip` → `sandbox-<os>-<arch>/sandbox.exe`
plus its `_internal/` support files). Run that `sandbox.exe` from the directory
whose contents should appear at `/data` in the VM (pass `--config` when
`config.jsonc` is elsewhere). Every run starts from the tagged image (or a
fresh base on first use), runs `initScript`, and replaces the tagged image:

```bash
cd /path/to/your/workspace          # this becomes /data
path/to/sandbox-windows-x64/sandbox.exe --config path/to/config.jsonc

# Optional update-only mode: apply initScript, replace the image, then exit.
path/to/sandbox-windows-x64/sandbox.exe --config path/to/config.jsonc --init
```

What happens:

- generates `ssh/quicksand_demo` (+ `.pub`) **next to the launcher exe** (inside
  the extracted folder) and injects the public key into the VM
- boots the VM, mounts the current directory at `/data`, applies
  `sandbox.mounts` and `sandbox.portMapping`, forwards guest SSH to the first
  free loopback port from 52222 (published to `sandbox.cacheDir/ssh-port`)
- runs `initScript` with `SANDBOX_LIFECYCLE=create|update`, then atomically
  replaces `<sandbox.image>-<sandbox.imageTag>` before reporting readiness
- prints `Sandbox is ready` when SSH answers

Stop it with **Enter** in a console; when stdin is closed (background/CI) it
holds the VM open for **5 minutes**, then shuts down. Killing the process also
tears the VM down.

## 4. Run `embed-*.exe`

Start it AFTER the sandbox is ready (it reads the published ssh-port file).
It needs to know where the sandbox keypair is:

```bash
cd /path/to/your/workspace          # same directory as the sandbox: it is /data
export SSH_KEY=/path/to/sandbox-*/ssh/quicksand_demo      # Windows: set SSH_KEY=...
./embed-windows-x64.exe --config path/to/config.jsonc --workspace .
```

- `--config` — same file the sandbox uses (defaults to `./config.jsonc`)
- `--workspace` — directory mounted at `/data` and used as every session's
  working directory (defaults to the current directory; keep it identical to
  the sandbox's start directory)
- `SSH_KEY` env — the sandbox keypair; `SSH_USER` (default `root`) and
  `SSH_HOST` (default `localhost`) are optional
- on boot it pins the VM's host key next to the keypair (`known_hosts`), so
  every agent tool call connects silently and verified

Ready when it prints:

```
opencode embedder listening on http://localhost:14096
```

Stop with CTRL+C.

## 5. Drive it

```bash
opencode run --server http://localhost:14096 --auto \
  "Run the shell command: uname -r && hostname && head -3 /data/README.md"
```

`uname -r` returns the VM kernel (`6.8.0-…-generic`): every Read/Write/Shell
tool call executed inside the sandbox. File writes in the guest land in your
working directory and vice versa. Prefer single commands or `&&` chains in
"run this" instructions — semicolon chains with unicode punctuation can trip
opencode's portable shell scanner.

## Gotchas

- **`initScript` line endings must be LF** — a CRLF checkout (Windows default)
  fails in the guest with `set: pipefail: invalid option name`. The image name
  changes with the script's bytes, so a converted script also avoids a
  pointless rebuild.
- **Start order matters**: sandbox first (publishes the ssh port), embedder
  second. Rebooting the VM generates a new host key — restart the embedder so
  it re-pins.
- **Keep sandbox and embedder on the same `config.jsonc`** and the same
  working directory, or the workspace mount and the SSH target will diverge.
- Ports: the SSH forward picks the first free port ≥ 52222; `sandbox.portMapping`
  hosts ports must be free on the host.
