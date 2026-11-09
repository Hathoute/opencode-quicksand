# Testing the opencode-on-quicksand setup

Three pieces run in this order — each in its **own terminal** so they stay alive:

```
[1] bun run start:sandbox   → Ubuntu VM: sshd on 127.0.0.1:2222, caller's CWD mounted at /data
[2] bun run start:embed     → opencode embedder (SDK server) on http://localhost:4096
[3] opencode run            → drives the agent; every Read/Write/Shell executes in the VM
```

Prerequisites (one-time):
- bun: `winget install Oven-sh.Bun` (restart shell afterwards)
- python ≥ 3.11 on PATH (the sandbox venv bootstraps itself on first start)
- Z.AI Coding Plan API key (`ZAI_API_KEY` env or secret)

---

## 1. Start the ssh server (quicksand VM)

```powershell
cd C:\Users\Hathoute\Desktop\Dev\opencode-sandboxed\opencode-quicksand
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

Verify (the mount now holds the project root, so README.md is the sentinel):

```powershell
ssh -i quicksand\ssh\quicksand_demo -p 2222 root@127.0.0.1 "head -3 /data/README.md"
# → # opencode-quicksand …
```

## 2. Start the opencode embed server

```powershell
$env:ZAI_API_KEY = "<your Z.AI key>"
bun run start:embed
```

What it does: fetches the opencode checkout at the pinned commit into
`build\opencode` (reuses an existing clone), syncs `opencode/*.ts` into its
`poc/`, `bun install --frozen-lockfile`, creates the `effect` junction, then runs
`bun poc/embed.ts` → server on `http://localhost:4096` (sets `SSH_*`,
`WORKSPACE_HOST_DIR`, `SSH_DRIVER_LOG=1`).

Ready when you see:

```
opencode embedder listening on http://localhost:4096
placing sessions into ssh workspace wrk_quicksand_ssh at ...<your CWD>
```

Stop with CTRL+C (kills the whole bun/ssh child tree). `SSH_DRIVER_LOG=1` traces
every ssh invocation: remote command line, cwd, stdin mode, exit code + bytes.

## 3. Run opencode for testing

```powershell
opencode run --server http://localhost:4096 --auto `
  -m zai-coding-plan/glm-5.3-flash `
  "Run 'uname -r' and create a file sandbox-test.txt in the working directory `
  whose single line is that kernel version. Show me the final file content."
```

Afterwards verify the write-through on the host, then delete the scratch file:

```powershell
Get-Content .\sandbox-test.txt   # guest write visible on the host
Remove-Item .\sandbox-test.txt
```

- `--server` targets the embedder (the "version unknown" warning is expected —
  client 2.2.6 vs pinned server)
- `--auto` auto-approves tool permissions
- Session cwd is the mounted host directory (project root); **use host-relative
  or guest-native paths in prompts** — bare `/data/...` gets reinterpreted as
  `C:\data\...` by the host tool layer (see FINDINGS.md)

Useful test prompts:

```powershell
# commands execute inside the VM (hostname/uname prove it; /data = your CWD).
# Avoid `;` chains + unicode punctuation in run instructions — the portable
# shell scanner rejects them (FINDINGS.md #12). Use && chains instead.
opencode run --server http://localhost:4096 --auto -m zai-coding-plan/glm-5.3-flash `
  "Run the shell command: hostname && whoami && uname -a && head -3 /data/README.md"
```

Verify results from both sides:

```powershell
# host side
Get-Content README.md -TotalCount 3
# guest side
ssh -i quicksand\ssh\quicksand_demo -p 2222 root@127.0.0.1 "head -3 /data/README.md; wc -c /data/README.md"
```

## Driver-level streaming check (no opencode needed)

```powershell
cd build\opencode   # the pinned checkout (populated by bun run start:embed)
$env:SSH_KEY = "C:\Users\Hathoute\Desktop\Dev\opencode-sandboxed\opencode-quicksand\quicksand\ssh\quicksand_demo"
bun poc/stream-test.ts
# lines must arrive ~2s apart, not in one burst at exit
```

## Standalone executables

```powershell
bun run build:embed     # → build\dist\embed.exe    (~158 MB)
bun run build:sandbox   # → build\dist\sandbox.exe  (~351 MB)
bun run build:all
```

- `embed.exe`: set `PORT`, `SSH_KEY`, `ZAI_API_KEY`, `WORKSPACE_HOST_DIR`,
  optional `SSH_DRIVER_LOG`, then run it — no repo, bun or node_modules needed
- `sandbox.exe`: creates `ssh\` next to itself; the VM mounts the directory the
  exe is STARTED FROM at `/data` (`SANDBOX_MOUNT_DIR` overrides). Needs Windows
  OpenSSH client on PATH. First start extracts the archive to %TEMP% (~10–20 s)

## Troubleshooting quick reference

| Symptom | Cause / fix |
|---------|-------------|
| `Model unavailable: zai-coding-plan/...` | embedder DB is in-memory; start embed with `ZAI_API_KEY` set (FINDINGS.md #1) |
| `Transport: ECONNRESET` mid-session | embedder started with old `embed.ts` (no `idleTimeout: 255`); restart via `bun run start:embed` (FINDINGS.md #2c) |
| Session not placed (`session undefined`) | old `embed.ts` without the `event.data.sessionID` fix; resync + restart |
| `command not found` for a Windows path in the guest | old `driver.ts` without `guestShell()`; resync + restart |
| Tool call fails with `Portable shell scanner cannot analyze command: invalid-structure` | prompt asked the model to run a `;` chain with unicode punctuation (FINDINGS.md #12); use single commands or `&&` chains |
| First tool call of a session ran on the host (e.g. MSYS2 `uname -r`) | old `embed.ts` without born-in-workspace create interception (FINDINGS.md #11); resync + restart |
| `bun install` dies with `NativeCommandError` | run through the bun scripts (they wrap native commands; FINDINGS.md #4) |
| Mount fails at VM boot with `Host is down` | sandbox not started with `NetworkMode.FULL` (`quicksand/sandbox.py` handles this; FINDINGS.md #5) |
| Writes produce empty files / Edit hangs | old `driver.ts` without stdin wiring; resync + restart (FINDINGS.md #9) |
