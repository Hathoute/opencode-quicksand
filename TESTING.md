# Testing the opencode-quicksand setup

Three pieces run in this order — each in its **own terminal** so they stay alive:

```
[1] bun run start:sandbox   → Ubuntu VM: sshd on 127.0.0.1:2222, caller's CWD mounted at /data
[2] bun run start:embed     → opencode embedder (SDK server) on http://localhost:4096
[3] opencode run            → drives the agent; every Read/Write/Shell executes in the VM
```

## Host platform support

The guest is always the same Ubuntu VM — it's the **host** that varies. What
works per host OS today:

| Piece | Windows | Linux | macOS |
|-------|---------|-------|-------|
| 1 · sandbox VM (`bun run start:sandbox`) | ✅ | ✅ verified | ✅ quicksand ships QEMU + image wheels for all three OSes |
| 2 · embedder (`bun run start:embed`) | ✅ | ✅ verified | ✅ bun scripts are portable; the `effect` junction becomes a plain symlink |
| 3 · agent tools in the VM (`opencode run`) | ✅ | ✅ verified end-to-end (shell, Write, Read all executed in the guest) | ⚠️ adapter implemented (`driver-macos.ts`), not yet exercised |
| Driver-level streaming check | ✅ | ✅ verified (lines ~2s apart, not burst) | ⚠️ same adapter, untested |
| Standalone packaging (`build:*`) | ✅ exercised | ✅ verified: embed cross-compiles all targets from one host, sandbox built via uv | ⚠️ CI builds macos-arm64 binaries; not yet exercised on Apple hardware |

"Verified" = exercised end-to-end on that host OS. The POSIX adapters
(`driver-linux.ts`, `driver-macos.ts`) were originally throwing stubs; the
Linux one is now implemented and verified, macOS is implemented by symmetry
but has not been run on Apple hardware.

Prerequisites (one-time):

- bun — Windows: `winget install Oven-sh.Bun` · Linux:
  `curl -fsSL https://bun.sh/install | bash` · macOS: `brew install bun`
  (restart the shell afterwards)
- uv — Windows: `winget install --id=astral-sh.uv` · Linux/macOS:
  `curl -LsSf https://astral.sh/uv/install.sh | sh`. It manages Python itself
  (interpreter pinned by `.python-version`, dependencies by `uv.lock`) — no
  system Python or pip required
- OpenSSH client on PATH (`ssh`, `ssh-keygen`, `ssh-keyscan`) — Windows: the
  "OpenSSH Client" optional capability · Linux: `openssh-client` · macOS: built in
- the `opencode` CLI on PATH (for step 3)
- a Z.AI Coding Plan API key (`ZAI_API_KEY` env or secret)

---

## 1. Start the ssh server (quicksand VM)

From the repo root (wherever you cloned it — same command in bash and
PowerShell; `bun run` executes scripts from the project root, and the VM
mounts that directory at `/data`):

```bash
cd opencode-quicksand
bun run start:sandbox
```

- Generates `quicksand/ssh/quicksand_demo` (+`.pub`) on first run and injects the
  pubkey into the VM (key auth, `BatchMode` — no password prompts for the driver)
- Boots Ubuntu with `NetworkMode.FULL`, mounts **the directory you run it from**
  (the project root when invoked via `bun run start:sandbox`; override with
  `SANDBOX_MOUNT_DIR`) at `/data`, forwards guest 22 → host `127.0.0.1:2222`
- Interactive terminal: waits for **Enter** to stop. Background/CI (stdin EOF):
  holds the VM open for **5 minutes**, then shuts down
- Wait for `Sandbox is ready:` (~1 min: boot + sshd setup)

Verify (works from any host; the mount now holds the project root, so README.md
is the sentinel — forward slashes are fine in PowerShell too):

```bash
ssh -i quicksand/ssh/quicksand_demo -p 2222 \
  -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@127.0.0.1 \
  "head -3 /data/README.md"
# → # opencode-quicksand …
```

(`accept-new` keeps the first connection non-interactive: a fresh host has no
known_hosts entry yet, and `BatchMode` alone would turn the host-key prompt
into a hard `Host key verification failed`.)

## 2. Start the opencode embed server

Set the key, then start — any host:

```bash
export ZAI_API_KEY="<your Z.AI key>"     # bash (Linux / macOS)
bun run start:embed
```

```powershell
$env:ZAI_API_KEY = "<your Z.AI key>"     # PowerShell (Windows)
bun run start:embed
```

What it does: fetches the opencode checkout at the pinned commit into
`build/opencode` (reuses an existing clone), syncs `opencode/*.ts` into its
`poc/`, `bun install --frozen-lockfile`, creates the `effect` junction (a
plain symlink on Linux/macOS), then runs `bun poc/embed.ts` → server on
`http://localhost:4096` (sets `SSH_*`, `WORKSPACE_HOST_DIR`, `SSH_DRIVER_LOG=1`).

Ready when you see:

```
opencode embedder listening on http://localhost:4096
placing sessions into ssh workspace wrk_quicksand_ssh at ...<your CWD>
```

Stop with CTRL+C (kills the whole bun/ssh child tree). `SSH_DRIVER_LOG=1` traces
every ssh invocation: remote command line, cwd, stdin mode, exit code + bytes.

## 3. Run opencode for testing

Verified on Windows and Linux hosts (macOS adapter implemented, untested):

```powershell
opencode run --server http://localhost:4096 --auto `
  -m zai-coding-plan/glm-5.3-flash `
  "Run 'uname -r' and create a file sandbox-test.txt in the working directory `
  whose single line is that kernel version. Show me the final file content."
```

```bash
opencode run --server http://localhost:4096 --auto \
  -m zai-coding-plan/glm-5.3-flash \
  "Run 'uname -r' and create a file sandbox-test.txt in the working directory whose single line is that kernel version. Show me the final file content."
```

Afterwards verify the write-through on the host, then delete the scratch file:

```powershell
Get-Content .\sandbox-test.txt   # guest write visible on the host
Remove-Item .\sandbox-test.txt
```

```bash
cat sandbox-test.txt             # guest write visible on the host
rm sandbox-test.txt
```

- `--server` targets the embedder (the "version unknown" warning is expected —
  client 2.2.6 vs pinned server)
- `--auto` auto-approves tool permissions
- The kernel version must be the **guest's** (`6.8.0-147-generic` for the
  current image) — if you see the host kernel, the session leaked (FINDINGS.md #11)
- Session cwd is the mounted host directory (project root); use host-relative
  or guest-native paths in prompts. On **Windows** hosts bare `/data/...`
  gets reinterpreted as `C:\data\...` by the host tool layer (FINDINGS.md);
  on POSIX hosts guest-native paths pass through unchanged

Useful test prompts:

```powershell
# commands execute inside the VM (hostname/uname prove it; /data = your CWD).
# Avoid `;` chains + unicode punctuation in run instructions — the portable
# shell scanner rejects them (FINDINGS.md #12). Use && chains instead.
opencode run --server http://localhost:4096 --auto -m zai-coding-plan/glm-5.3-flash `
  "Run the shell command: hostname && whoami && uname -a && head -3 /data/README.md"
```

Verify results from both sides (the guest-side ssh check works from any host):

```powershell
# host side
Get-Content README.md -TotalCount 3
# guest side
ssh -i quicksand/ssh/quicksand_demo -p 2222 root@127.0.0.1 "head -3 /data/README.md; wc -c /data/README.md"
```

## 4. Driver-level streaming check (no opencode needed)

```bash
# repo root — SSH_KEY must be absolute because the script runs from build/opencode
export SSH_KEY="$PWD/quicksand/ssh/quicksand_demo"
cd build/opencode   # the pinned checkout (populated by bun run start:embed)
bun poc/stream-test.ts
# lines must arrive ~2s apart, not in one burst at exit
```

```powershell
# repo root — SSH_KEY must be absolute because the script runs from build/opencode
$env:SSH_KEY = "$PWD\quicksand\ssh\quicksand_demo"
cd build\opencode
bun poc/stream-test.ts
```

The sandbox must be running (this talks to the VM directly). A one-time
`Warning: Permanently added '[localhost]:2222' …` on stderr means the
embedder hasn't pinned the host key yet (`quicksand/ssh/known_hosts` absent) —
harmless; start the embedder once with the sandbox up to silence it.

## 5. Standalone executables

```bash
bun run build:embed                            # → build/dist/embed-<os>-<arch>[.exe] (host target)
EMBED_TARGET=windows-x64 bun run build:embed   # cross-compiles from any host
EMBED_TARGET=linux-x64 bun run build:embed
EMBED_TARGET=linux-arm64 bun run build:embed
EMBED_TARGET=macos-arm64 bun run build:embed
bun run build:sandbox                          # → build/dist/sandbox-<os>-<arch>[.exe] (uv + PyInstaller)
bun run build:all
```

- `embed-*` (~140-160 MB): plain `bun build --compile` — source embedded, JIT
  at runtime (`bytecode: true` compiles but yields a silent no-op executable
  on Bun 1.4.4, and machine-code AOT cannot cross-compile; notes in
  `build/build-embed-exe.ts`). Cross-compiles every target from one host; the
  pty binary of the *target* platform is force-installed and embedded
  (upstream's technique). Runs with `PORT`, `SSH_KEY`, `ZAI_API_KEY`,
  `WORKSPACE_HOST_DIR` (+ optional `SSH_DRIVER_LOG`) — no repo, bun or
  node_modules needed. Verified end-to-end: the compiled linux-x64 binary
  served an agent session whose tools executed inside the VM
- `sandbox-*` (~330 MB): PyInstaller onefile in the uv-managed `build`
  dependency-group (interpreter + quicksand + Ubuntu image + QEMU binaries).
  PyInstaller cannot cross-compile — build on the target platform. Creates
  `ssh/` next to itself; the VM mounts the directory the exe is STARTED FROM
  at `/data` (`SANDBOX_MOUNT_DIR` overrides). First start extracts the
  archive to the temp dir (~10-20 s)
- Release CI (`.github/workflows/release.yml`): push a `v*` tag → draft
  GitHub Release with `embed-{windows-x64.exe,linux-x64,linux-arm64,
  macos-arm64}` (one Linux runner, cross-compiled) +
  `sandbox-{windows-x64.exe,linux-x64,linux-arm64,macos-arm64}` (native
  runners, uv cache) + checksums. `workflow_dispatch` builds artifacts only

## Troubleshooting quick reference

| Symptom | Cause / fix |
|---------|-------------|
| `Host key verification failed` on the first manual `ssh` (under `BatchMode`) | fresh host: no known_hosts entry yet — add `-o StrictHostKeyChecking=accept-new` (as in the step 1 verify) |
| Every driver call logs `Warning: Permanently added '[localhost]:2222'`; embedder logged `ssh-keyscan got no host key` | IPv6-first `localhost` + forward bound to 127.0.0.1 (FINDINGS.md #13); fixed in `embed.ts` — resync + restart the embedder with the sandbox up |
| Manual `ssh` fails with `REMOTE HOST IDENTIFICATION HAS CHANGED` | the VM generates fresh host keys every boot — clear the stale user entry: `ssh-keygen -R "[127.0.0.1]:2222"` (the driver is unaffected: the embedder re-pins `quicksand/ssh/known_hosts` each boot) |
| MCP server spawn exits 127 in the guest (e.g. `/…/browse mcp`) | host-installed MCP binaries don't exist in the VM (FINDINGS.md #14); harmless for Read/Write/Shell |
| `uv: command not found` during start/build | install uv (see prerequisites) — it also manages the Python interpreter, so no system python is needed |
| `Model unavailable: zai-coding-plan/...` | embedder DB is in-memory; start embed with `ZAI_API_KEY` set (FINDINGS.md #1) |
| `Transport: ECONNRESET` mid-session | embedder started with old `embed.ts` (no `idleTimeout: 255`); restart via `bun run start:embed` (FINDINGS.md #2c) |
| Session not placed (`session undefined`) | old `embed.ts` without the `event.data.sessionID` fix; resync + restart |
| `command not found` for a Windows path in the guest (Windows) | old `driver.ts` without `guestShell()`; resync + restart |
| Tool call fails with `Portable shell scanner cannot analyze command: invalid-structure` | prompt asked the model to run a `;` chain with unicode punctuation (FINDINGS.md #12); use single commands or `&&` chains |
| First tool call of a session ran on the host, e.g. MSYS2 `uname -r` (Windows) | old `embed.ts` without born-in-workspace create interception (FINDINGS.md #11); resync + restart |
| `bun install` dies with `NativeCommandError` (Windows PowerShell 5.1) | run through the bun scripts (they wrap native commands; FINDINGS.md #4) |
| Mount fails at VM boot with `Host is down` (Windows) | sandbox not started with `NetworkMode.FULL` (`quicksand/sandbox.py` handles this; FINDINGS.md #5) |
| Writes produce empty files / Edit hangs | old `driver.ts` without stdin wiring; resync + restart (FINDINGS.md #9) |
