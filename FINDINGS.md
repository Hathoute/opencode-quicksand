# Findings — opencode-on-quicksand POC

Working setup: quicksand Ubuntu VM (sshd on host :2222, key auth via `ssh/quicksand_demo`,
host `./data` mounted at `/data`, NetworkMode.FULL) + opencode embedder
(`run_opencode.ps1` → `poc/embed.ts`) with an SSH workspace driver (`poc/driver.ts`).

## 1. Embedded host can't see global credentials (in-memory DB)

**Symptom:** `opencode run --server http://localhost:4096 -m zai-coding-plan/glm-5.3-flash`
fails with `Model unavailable: zai-coding-plan/glm-5.3-flash`, even though
`opencode auth export` shows the stored, active credential.

**Root cause:** `packages/sdk/src/internal/host.ts` boots the embedded server with
`database: { path: ":memory:", ...server.database }`. Credentials live in the global DB
(`~/.local/share/opencode/opencode.db`, migrated from legacy `auth.json`), so the
embedder's empty in-memory DB means the `zai-coding-plan` provider never activates
(`/api/provider` lists only the built-in `opencode` provider).

**Fix (applied):** inject provider auth via server options config —
`ServerOptions.config.content` accepts a JSON config string:

```ts
config: {
  content: JSON.stringify({
    provider: { "zai-coding-plan": { options: { apiKey: process.env.ZAI_API_KEY } } },
  }),
}
```

`run_opencode.ps1 -ApiKey <key>` (defaults to `$env:ZAI_API_KEY`) → sets
`ZAI_API_KEY` → `embed.ts` builds the config.

**Alternative:** pass `database: { path: "<global>/opencode.db" }` in
`EmbeddedHost.create` options to share the global store.

## 2. Session placement fails for CLI-created sessions (event envelope shape)

**Symptom:** sessions created by `opencode run --server …` were never placed into
the ssh workspace; `failed to place session undefined: … NotFoundError … session.ts:54`.

**Root cause:** `Bus.subscribe(D)` emits `Event.Payload<D>` **envelopes** — the event
payload fields live under `event.data`, not at the top level
(`packages/schema/src/event.ts` `PayloadBase`). `embed.ts` read `event.sessionID`
(undefined) instead of `event.data.sessionID`.

**Fix (applied):** read `event.data.sessionID` in the placement subscriber.
Verified: `session ses_e46d38b50ffeqkGMKDhBAts8lv placed into ssh workspace`.

## 2b. Shell tool issued host-shell commands to the Linux guest

**Symptom:** after placement worked, the agent's shell command arrived at the VM as
`C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.EXE -Command …` — bash:
`command not found`. The shell tool resolves its shell against the **host**
platform (`packages/core/src/shell/select.ts`, falls back to `win()[0]` = PowerShell
when no config shell is set).

**Fix (applied, two parts):**
1. `embed.ts` injects `shell: "bash"` in the embedder config, so the tool resolves a
   bash shell and the model writes POSIX commands.
2. `driver.ts` `guestShell()` translates Windows shell invocations at the spawner
   boundary (same philosophy as the path map): powershell/pwsh/cmd → guest
   `bash -c <script>`; `*.exe` bash paths → plain `bash`.

**Verified end-to-end** (`opencode run --server … --auto -m zai-coding-plan/glm-5.3-flash`
prompted to run `hostname; whoami; uname -a; cat /data/data.txt`):

```
localhost
root
Linux localhost 6.8.0-147-generic … x86_64 GNU/Linux
hello from mounted host
```

## 2c. Provider ECONNRESET — RESOLVED: Bun.serve idleTimeout

Every multi-step run died after its first tool result with
`Transport: ECONNRESET: The socket connection was closed unexpectedly`. The
embedder logs showed `Bun.serve() timed out a request after 10 seconds` at the
same moments: Bun's default `idleTimeout` (10s) kills requests that sit idle —
exactly what happens while the model thinks before streaming its next step.

**Fix (applied):** `embed.ts` passes `idleTimeout: 255` (Bun's max) to
`Bun.serve`. Multi-step sessions now run to completion without transport errors.

## 9. Files-plane writes: stdin was discarded (empty files / hangs)

**Symptom:** `data.txt` truncated to 0 bytes after model write attempts; the
interactive session stuck on the Edit/Write tool.

**Root cause:** `execDefaults.write` sends file bytes via `command.options.stdin`
(a `Stream<Uint8Array>`) into a remote `cat > "$1"` — the spawner is contractually
responsible for pumping that stream into the child's stdin. The ssh driver spawned
ssh with `stdin: "ignore"` and declared `stdin: Sink.drain`, so file bytes were
discarded (`cat` wrote 0 bytes — truncating the file) and depending on how stdin
was handled the remote `cat` could wait on EOF (the hang).

**Fix (applied):**
- spawn with `stdin: "pipe"`, pump `command.options.stdin` into Bun's stdin sink,
  always `end()` it so the guest sees EOF
- `handle.stdin` is a real `Sink.forEach` writer instead of `Sink.drain`

**Verified:** model read `data.txt`, wrote `patched using opencode`, re-read it;
host and guest files both show identical 23-byte content (mount write-through
works in both directions). Also added `SSH_DRIVER_LOG=1` tracing
(`run_opencode.ps1` sets it): every spawn logs the remote command line, cwd,
stdin mode, and exit code with stdout/stderr byte counts.

## 10. PyInstaller packaging of sandbox.py (frozen-mode pitfalls)

`sandbox.exe` = PyInstaller onefile (351 MB: interpreter + deps + Ubuntu image +
QEMU binaries + dist metadata). Four frozen-mode issues, all handled in
`sandbox.py` / build flags:

1. **Reaper fork bomb:** quicksand spawns QEMU as
   `[sys.executable, _reaper.py, "--", qemu...]`. Frozen, `sys.executable` is
   `sandbox.exe` → every spawn re-ran the whole app (~200 processes in seconds).
   Fix: `patch_frozen_qemu()` monkeypatches `VMProcessManager.start` to spawn
   QEMU directly. Trade-off: the reaper's crash-cleanup is gone (orphaned QEMU
   if the exe dies hard); graceful stop still works — `terminate()` closes
   stdin, waits, then hard-kills QEMU. Also note the class is
   `VMProcessManager`, not `QemuProcess`.
2. **`__file__` in temp dir:** PyInstaller onefile extracts to `%TEMP%\_MEIxxx`,
   so `Path(__file__).parent` points at throwaway files. Fix: `_project_root()`
   returns `Path(sys.executable).parent` when frozen — `data/` and `ssh/` are
   created next to the exe.
3. **Entry-point metadata:** image providers are discovered via the
   `quicksand.images` entry point and versions via `importlib.metadata` —
   PyInstaller ships no dist metadata by default. Fix: `--copy-metadata` for
   quick-sandbox/core/qemu/ubuntu/smb (plus `--collect-all` for package data:
   qcow2/kernel/initrd + QEMU binaries).
4. **onfile startup cost:** ~351 MB extraction to %TEMP% per launch (~10–20 s).
   Use `--onedir` instead if startup latency matters more than a single file.

Verified: `dist\sandbox.exe` boots the VM, answers ssh on 2222 (banner +
key auth), and serves the mounted `data/data.txt` through the mount.

## 8. Streaming: guest commands deliver lines as printed

The ssh spawner's `stdout`/`stderr` handles are live Bun pipe streams, so the only
buffering in the chain was **remote-side**: without a TTY, guest programs
block-buffer stdout (4-8KB before sshd forwards anything).

**Fix (applied):** `driver.ts` `lineBuffered()` wraps the guest command in
`if command -v stdbuf >/dev/null 2>&1; then exec stdbuf -oL -eL <cmd>; else exec <cmd>; fi`
— line-buffered when the guest has stdbuf, byte-identical fallback otherwise.
The file plane (`sh` scripts from `execDefaults`) is deliberately left unwrapped
to keep its exact-format parsing byte-identical.

**Verified** (`poc/stream-test.ts`, command prints a line every 2s):

```
+2.1s stdout: "line-1\n"
+4.1s stdout: "line-2\n"
+6.1s stdout: "line-3\n"
+8.1s stdout: "line-4\n"
+10.1s stdout: "line-5\n"
+12.1s exit=0
```

**Residual limits:** `stdbuf` (LD_PRELOAD) only helps C-stdio programs; Python and
Node do their own userspace buffering — use `python3 -u` / unbuffered flags for
those. The opencode shell tool still *returns* its result at process end by design
(backing file + bounded tail); streaming consumers reading the Handle streams get
lines live.

## 3. Client/server version skew

The global CLI is 2.2.6; the embedder runs the pinned checkout
(`ced73dc0f6c5b00c3a085b1d7b11ea31f790c5df`) and reports "version unknown".
Consequences observed:
- CLI warns `Server … has version unknown … Continuing anyway` (harmless)
- `opencode models` (CLI registry) lists models the pinned server's catalog may not
  have — trust `/api/model` on the server for what is actually available
- Useful server introspection routes (via `opencode api --server http://localhost:4096`):
  `/api/provider`, `/api/model`, `/api/model/default`; spec at `/openapi.json`

## 4. Windows PowerShell 5.1 + EAP=Stop kills native commands on stderr

`$ErrorActionPreference = "Stop"` converts a native command's stderr output (bun's
`Resolving dependencies` progress, git chatter) into a terminating
`NativeCommandError` — the script dies mid `bun install`. Fixed in
`run_opencode.ps1` with an `Invoke-Native` helper: run native commands with
`$ErrorActionPreference = "Continue"` locally, then fail explicitly on
`$LASTEXITCODE`. Note git suppresses progress when stderr is redirected, which is
why only the bun step crashed.

## 5. quicksand mounts on Windows (context for why this sandbox uses FULL)

- QEMU on Windows silently fails to spawn `guestfwd=tcp:…-cmd:` helpers
  (`_tcp_relay.py`): slirp accepts the guest's TCP, then the stream dies —
  `mount error(112): Host is down`, host SMB server sees zero connections.
  No firewall involvement (loopback connect verified working; no block events).
- quicksand `MOUNTS_ONLY` (default) routes mounts through exactly that broken
  helper ⇒ boot-time mounts fail on Windows. `NetworkMode.FULL` routes mounts via
  the slirp gateway (`10.0.2.2:port`) and works — that's what `sandbox.py` uses.
- Same mechanism backs `Forward(Guest, Host)` port forwards ⇒ likely broken on
  Windows in all network modes (untested here, same code path:
  `quicksand_core/qemu/platform.py::_relay_guestfwd`, called from
  `_build_network_args` regardless of network mode).
- Not yet reported upstream (neither microsoft/quicksand nor qemu-project;
  searched both trackers — no existing issue for the Windows `cmd:` spawn failure).

## 11. First-turn host leak: post-create session placement is racy

**Symptom:** a fresh `opencode run` session executed its first Bash call on the
Windows host (`uname -r` → `3.4.10-87d57229.x86_64`, the MSYS2/Git Bash kernel)
instead of the VM (`6.8.0-147-generic`). Other sessions won the race and ran in
the guest — nondeterministic.

**Root cause:** the embedder placed sessions by subscribing to
`SessionEvent.Created` and calling `sessions.move`. A move is only delivered at
a "safe inbox boundary" of the session runner, so a session created
implicit-local and promptly prompted runs its ENTIRE first turn on the host
(`environment.ts` picks `makeLocalDriver` while `location.workspaceID` is
unset). The bus event sometimes completes the move before the first prompt is
admitted — sometimes not.

**Why not rewrite the request body:** `POST /api/session` decodes its payload
against `Location.PublicRef` = `Location.Ref` minus `workspaceID`
(`packages/schema/src/location.ts`); effect `Schema.Struct` decode strips
undeclared keys, so an injected `workspaceID` never reaches the handler.

**Fix (embed.ts):** intercept the create in the `host.fetch` wrapper and call
the core `host.sessions.create` (in-process API — full `Location.Ref` keeps
`workspaceID`) with `location: { directory, workspaceID }`. The session is BORN
in the workspace; the first drain resolves `workspace.connect()` and no boundary
handoff exists. Synthesize the `{ data: session }` JSON response (the extra
`workspaceID` key is stripped by the client decode). `parentID` creates
(children inherit the parent's location) and explicit `id` adoptions pass
through; the bus sweep remains as the fallback mover.

## 12. Shell scanner rejects some compound prompts

**Symptom:** a prompt asking the model to run `hostname; whoami; uname -a;
head -3 /data/README.md — show the complete output` fails the tool call with
`Portable shell scanner cannot analyze command: invalid-structure` (the same
error reproduces in any host running the portable scanner, including the
opencode harness itself).

**Cause:** the shell tool analyzes the command the model wants to run with the
portable (non-wasm) scanner; the semicolon chain + unicode punctuation
combination trips its tokenizer. Single commands and `&&` chains analyze fine.

**Workaround:** phrase prompts with single commands or `&&` chains; avoid `;`
chains and unicode punctuation inside "run this" instructions.
