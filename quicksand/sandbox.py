"""Ubuntu sandbox demo:
- derives a persistent image name from sandbox.initScript's SHA-256
- --init creates that image from Ubuntu when it does not already exist
- NetworkMode.FULL (internet access)
- mounts the launcher's current working directory at /data in the VM
- guest SSH (22) exposed on host 127.0.0.1:2222
- generates ./ssh/quicksand_demo next to the script (next to the exe when
  frozen) and injects the pubkey into the VM so opencode's ssh driver can
  log in non-interactively (BatchMode)
"""

import argparse
import asyncio
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from quicksand import Forward, Guest, Host, Mount, NetworkMode, Sandbox


def _arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="config.jsonc")
    parser.add_argument("--init", action="store_true")
    return parser.parse_args()


def _script_dir() -> Path:
    """Where ssh/ keys live: next to this script. Frozen (PyInstaller onefile)
    __file__ points into the temp extraction dir, so use the exe's directory."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


def _load_config(file: Path) -> tuple[Path, Path]:
    if not file.is_file():
        raise FileNotFoundError(f"config file not found: {file}")
    config = json.loads(_strip_trailing_commas(_strip_comments(file.read_text())))
    try:
        sandbox = config["sandbox"]
        init_script = sandbox["initScript"]
        cache_dir = sandbox["cacheDir"]
    except (KeyError, TypeError) as error:
        raise ValueError(f"invalid sandbox config in {file}: {error}") from error
    if not isinstance(init_script, str) or not init_script.strip():
        raise ValueError("sandbox.initScript must be a non-empty string")
    if not isinstance(cache_dir, str) or not cache_dir.strip():
        raise ValueError("sandbox.cacheDir must be a non-empty string")
    return _resolve(file.parent, init_script), _resolve(file.parent, cache_dir)


def _resolve(base: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return (base / path).resolve() if not path.is_absolute() else path.resolve()


def _strip_comments(text: str) -> str:
    output: list[str] = []
    index = 0
    quoted = False
    escaped = False
    while index < len(text):
        char = text[index]
        if quoted:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            index += 1
            continue
        if char == '"':
            quoted = True
            output.append(char)
            index += 1
            continue
        if text[index : index + 2] == "//":
            index += 2
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        if text[index : index + 2] == "/*":
            index += 2
            while index < len(text) and text[index : index + 2] != "*/":
                if text[index] == "\n":
                    output.append("\n")
                index += 1
            index += 2
            continue
        output.append(char)
        index += 1
    return "".join(output)


def _strip_trailing_commas(text: str) -> str:
    output: list[str] = []
    quoted = False
    escaped = False
    for index, char in enumerate(text):
        if quoted:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
            continue
        if char == '"':
            quoted = True
            output.append(char)
            continue
        if char == "," and text[index + 1 :].lstrip().startswith(("}", "]")):
            continue
        output.append(char)
    return "".join(output)


def _validate_init_script(script: Path) -> Path:
    if not script.is_file():
        raise FileNotFoundError(f"sandbox.initScript does not exist or is not a file: {script}")
    return script


def patch_frozen_qemu():
    """Frozen exe: sys.executable is sandbox.exe itself, so quicksand's
    [sys.executable, _reaper.py, --, qemu...] wrapper re-runs the whole app
    (fork bomb). Spawn QEMU directly instead; stop/terminate still works —
    terminate() closes stdin, waits, then hard-kills the QEMU process. The
    reaper's crash-cleanup (orphaned QEMU if the exe dies hard) is lost, and
    guest_forwards/MOUNTS_ONLY relays would also break frozen — this build
    uses NetworkMode.FULL, which routes mounts via the slirp gateway."""
    if not getattr(sys, "frozen", False):
        return
    from quicksand_core.qemu import process as qemu_process

    def start(self, command, env, console_log_path):
        if self._process is not None:
            raise RuntimeError("Process already started")
        self._command = list(command)
        self._console_log = console_log_path
        self._console_file = self._console_log.open("w")
        creationflags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        self._process = subprocess.Popen(
            command,
            stdout=self._console_file,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            env=env,
            creationflags=creationflags,
        )
        qemu_process.logger.debug("Started QEMU directly (frozen mode), PID %d", self._process.pid)

    qemu_process.VMProcessManager.start = start
    print("frozen mode: QEMU reaper wrapper disabled (direct spawn)")


ARGS = _arguments()
CONFIG_FILE = Path(ARGS.config).expanduser().resolve()
INIT_SCRIPT, CACHE_DIR = _load_config(CONFIG_FILE)
MOUNT_DIR = Path.cwd().resolve()
INIT_SCRIPT = _validate_init_script(INIT_SCRIPT)
INIT_MOUNT_DIR = INIT_SCRIPT.parent / "init"
if not INIT_MOUNT_DIR.is_dir():
    raise FileNotFoundError(f"sandbox init mount does not exist or is not a directory: {INIT_MOUNT_DIR}")
KEY_PATH = _script_dir() / "ssh" / "quicksand_demo"
IMAGE_NAME = f"ubuntu-{hashlib.sha256(INIT_SCRIPT.read_bytes()).hexdigest()}"
IMAGE_PATH = CACHE_DIR / IMAGE_NAME
patch_frozen_qemu()


def ensure_keypair() -> str:
    """Generate an ed25519 keypair once; return the public key line."""
    KEY_PATH.parent.mkdir(exist_ok=True)
    if not KEY_PATH.exists():
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-f", str(KEY_PATH)],
            check=True,
        )
    return KEY_PATH.with_suffix(".pub").read_text().strip()


async def init_image():
    if IMAGE_PATH.exists():
        Sandbox.validate_save(IMAGE_PATH)
        print(f"Sandbox image already exists: {IMAGE_NAME}")
        return

    print(f"Creating sandbox image {IMAGE_NAME} from {INIT_SCRIPT}...")
    print(f"Init mount: {INIT_MOUNT_DIR} -> /mnt/init (not persisted automatically)")
    # The base image is intentionally small; toolchain init scripts (JDK, Node,
    # build tools) need room beyond its default virtual disk size. qcow2 keeps
    # this sparse on the host.
    async with Sandbox(
        image="ubuntu",
        network_mode=NetworkMode.FULL,
        disk_size="10G",
        mounts=[Mount(str(INIT_MOUNT_DIR), "/mnt/init")],
    ) as sb:
        result = await sb.execute(
            "bash -s",
            stdin=INIT_SCRIPT.read_bytes(),
            timeout=900,
            on_stdout=lambda chunk: print(chunk, end="", flush=True),
            on_stderr=lambda chunk: print(chunk, file=sys.stderr, end="", flush=True),
        )
        if result.exit_code != 0:
            raise RuntimeError(f"sandbox.initScript failed with exit code {result.exit_code}")
        await sb.save(IMAGE_NAME, workspace=CACHE_DIR)
    print(f"Sandbox image saved: {IMAGE_NAME}")


async def main():
    pubkey = ensure_keypair()
    print(f"SSH keypair: {KEY_PATH} (+ .pub)")
    print(f"Sandbox image: {IMAGE_NAME}")

    async with Sandbox(
        image=str(IMAGE_PATH),
        network_mode=NetworkMode.FULL,
        mounts=[Mount(str(MOUNT_DIR), "/data")],
        port_forwards=[Forward(Host(2222), Guest(22))],
    ) as sb:
        # Sanity check: the mount is live. The content is whatever the caller's
        # directory holds, so only assert that /data exists and is listable —
        # no specific file is guaranteed to be there anymore.
        result = await sb.execute("test -d /data && ls /data && echo MOUNT-OK")
        mount_ok = "MOUNT-OK" in result.stdout
        print(f"Mount check  (ls {MOUNT_DIR} as /data): {'OK' if mount_ok else 'FAILED'}")
        print(f"  /data: {result.stdout.strip().replace(chr(10), ', ')[:200]!r}")

        # Refresh the authorized key on every boot. OpenSSH installation and
        # service configuration belong to sandbox.initScript; intentionally do
        # not validate sshd here, so a broken custom image fails at the driver.
        await sb.execute(
            "mkdir -p /root/.ssh && cat > /root/.ssh/authorized_keys && "
            "chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys",
            stdin=pubkey + "\n",
            timeout=30,
        )

        print()
        print("Sandbox is ready:")
        print(f"  SSH (key):  ssh -i {KEY_PATH} -p 2222 root@127.0.0.1")
        print(f"  SSH (pw):   ssh -p 2222 root@127.0.0.1          (password: root)")
        print(f"  Mount:      host {MOUNT_DIR} -> guest /data")
        print(f"  Port rule:  host 127.0.0.1:2222 -> guest 22")

        # Hold the sandbox open until the user is done
        try:
            await asyncio.to_thread(input, "Press Enter to stop the sandbox...")
        except EOFError:
            print("(non-interactive: holding sandbox open for 5 minutes)")
            await asyncio.sleep(300)

if ARGS.init:
    asyncio.run(init_image())
else:
    asyncio.run(main())
