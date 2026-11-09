"""Quicksand sandbox demo:
- derives a persistent image name from sandbox.image and sandbox.initScript's SHA-256
- --init creates that image from the configured base when it does not already exist
- NetworkMode.FULL (internet access)
- mounts the launcher's current working directory at /data in the VM
- configured non-SSH forwards plus guest SSH on the first free host port from 52222
- generates ./ssh/quicksand_demo next to the script (next to the exe when
  frozen) and injects the pubkey into the VM so opencode's ssh driver can
  log in non-interactively (BatchMode)
"""

import argparse
import atexit
import asyncio
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
from pathlib import Path

from quicksand import Forward, Guest, Host, Mount, NetworkMode, Sandbox


def _force_utf8_stdio() -> None:
    # Guest output (apt progress, tool banners) contains non-ASCII bytes; with
    # console redirection on Windows Python decodes/encodes stdio as cp1252 and
    # print() raises UnicodeEncodeError mid-stream, killing the whole run. Force
    # UTF-8 with replacement for both directions.
    for stream in (sys.stdout, sys.stderr):
        encoding = (getattr(stream, "encoding", "") or "").lower().replace("-", "")
        if encoding != "utf8" and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")


_force_utf8_stdio()


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


def _load_config(
    file: Path,
) -> tuple[
    str,
    Path,
    Path,
    list[tuple[str, int, str, int]],
    list[tuple[Path, str]],
    int,
    str,
    str,
    bool,
]:
    if not file.is_file():
        raise FileNotFoundError(f"config file not found: {file}")
    config = json.loads(_strip_trailing_commas(_strip_comments(file.read_text())))
    try:
        sandbox = config["sandbox"]
        image = sandbox.get("image", "ubuntu")
        cpus = sandbox.get("cpus", 1)
        memory = sandbox.get("memory", "512M")
        disk_size = sandbox.get("diskSize", "10G")
        enable_display = sandbox.get("enableDisplay", False)
        init_script = sandbox["initScript"]
        cache_dir = sandbox["cacheDir"]
        mount_config = sandbox.get("mounts", [])
        environment = sandbox.get("env", {})
        port_mapping = sandbox["portMapping"]
    except (AttributeError, KeyError, TypeError) as error:
        raise ValueError(f"invalid sandbox config in {file}: {error}") from error
    if not isinstance(image, str) or not image.strip():
        raise ValueError("sandbox.image must be a non-empty string")
    if isinstance(cpus, bool) or not isinstance(cpus, int) or cpus < 1:
        raise ValueError("sandbox.cpus must be a positive integer")
    if not isinstance(memory, str) or not memory.strip():
        raise ValueError("sandbox.memory must be a non-empty string")
    if not isinstance(disk_size, str) or not disk_size.strip():
        raise ValueError("sandbox.diskSize must be a non-empty string")
    if not isinstance(enable_display, bool):
        raise ValueError("sandbox.enableDisplay must be a boolean")
    if not isinstance(init_script, str) or not init_script.strip():
        raise ValueError("sandbox.initScript must be a non-empty string")
    if not isinstance(cache_dir, str) or not cache_dir.strip():
        raise ValueError("sandbox.cacheDir must be a non-empty string")
    mappings = _parse_port_mappings(port_mapping)
    mounts = _parse_mounts(mount_config, file.parent)
    _validate_environment(environment)
    return (
        image,
        _resolve(file.parent, init_script),
        _resolve(file.parent, cache_dir),
        mappings,
        mounts,
        cpus,
        memory,
        disk_size,
        enable_display,
    )


def _validate_port(value: object, name: str) -> None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1 or value > 65_535:
        raise ValueError(f"{name} must be an integer between 1 and 65535")


def _parse_port_mappings(value: object) -> list[tuple[str, int, str, int]]:
    if not isinstance(value, list):
        raise ValueError("sandbox.portMapping must be an array")
    mappings: list[tuple[str, int, str, int]] = []
    for index, mapping in enumerate(value):
        if not isinstance(mapping, dict):
            raise ValueError(f"sandbox.portMapping[{index}] must be an object")
        try:
            source = _parse_endpoint(mapping["from"], f"sandbox.portMapping[{index}].from")
            destination = _parse_endpoint(mapping["to"], f"sandbox.portMapping[{index}].to")
        except KeyError as error:
            raise ValueError(f"invalid sandbox.portMapping[{index}]: missing {error}") from error
        mappings.append((*source, *destination))
    return mappings


def _parse_endpoint(value: object, name: str) -> tuple[str, int]:
    if not isinstance(value, str):
        raise ValueError(f"{name} must use Host(<port>) or Guest(<port>)")
    match = re.fullmatch(r"(Host|Guest)\(([0-9]+)\)", value)
    if not match:
        raise ValueError(f"{name} must use Host(<port>) or Guest(<port>)")
    port = int(match.group(2))
    _validate_port(port, name)
    return match.group(1), port


def _parse_mounts(value: object, base: Path) -> list[tuple[Path, str]]:
    if not isinstance(value, list):
        raise ValueError("sandbox.mounts must be an array")
    mounts: list[tuple[Path, str]] = []
    for index, mount in enumerate(value):
        if not isinstance(mount, dict):
            raise ValueError(f"sandbox.mounts[{index}] must be an object")
        try:
            host = mount["host"]
            guest = mount["guest"]
        except KeyError as error:
            raise ValueError(f"invalid sandbox.mounts[{index}]: missing {error}") from error
        if not isinstance(host, str) or not host.strip():
            raise ValueError(f"sandbox.mounts[{index}].host must be a non-empty string")
        if not isinstance(guest, str) or not guest.startswith("/"):
            raise ValueError(f"sandbox.mounts[{index}].guest must be an absolute guest path")
        if guest in {"/data", "/mnt/init"}:
            raise ValueError(f"sandbox.mounts[{index}].guest conflicts with reserved mount {guest}")
        mounts.append((_resolve(base, host), guest))
    return mounts


def _validate_environment(value: object) -> None:
    if not isinstance(value, dict):
        raise ValueError("sandbox.env must be an object")
    for key, item in value.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            raise ValueError(f"sandbox.env has invalid variable name: {key}")
        if not isinstance(item, str):
            raise ValueError(f"sandbox.env.{key} must be a string")


def _resolve(base: Path, value: str) -> Path:
    path = Path(value).expanduser()
    return (base / path).resolve() if not path.is_absolute() else path.resolve()


def _available_ssh_port(start: int = 52_222) -> int:
    configured = {
        source_port
        for source, source_port, _destination, _destination_port in PORT_MAPPINGS
        if source == "Host"
    }
    for port in range(start, 65_536):
        if port in configured:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as candidate:
            try:
                candidate.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise RuntimeError(f"no free loopback port available from {start} through 65535")


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
(
    BASE_IMAGE,
    INIT_SCRIPT,
    CACHE_DIR,
    PORT_MAPPINGS,
    MOUNTS,
    CPUS,
    MEMORY,
    DISK_SIZE,
    ENABLE_DISPLAY,
) = _load_config(CONFIG_FILE)
MOUNT_DIR = Path.cwd().resolve()
INIT_SCRIPT = _validate_init_script(INIT_SCRIPT)
INIT_MOUNT_DIR = INIT_SCRIPT.parent / "init"
if not INIT_MOUNT_DIR.is_dir():
    raise FileNotFoundError(f"sandbox init mount does not exist or is not a directory: {INIT_MOUNT_DIR}")
KEY_PATH = _script_dir() / "ssh" / "quicksand_demo"
IMAGE_NAME = f"{BASE_IMAGE}-{hashlib.sha256(INIT_SCRIPT.read_bytes()).hexdigest()}"
IMAGE_PATH = CACHE_DIR / IMAGE_NAME
SSH_PORT_PATH = CACHE_DIR / "ssh-port"
VNC_PORT_PATH = CACHE_DIR / "vnc-port"
DESKTOP_SCREENSHOT_PATH = CACHE_DIR / "desktop.png"
PORT_FORWARDS = [
    Forward(
        Host(source_port) if source == "Host" else Guest(source_port),
        Host(destination_port) if destination == "Host" else Guest(destination_port),
    )
    for source, source_port, destination, destination_port in PORT_MAPPINGS
]
CONFIGURED_MOUNTS = [Mount(str(host), guest) for host, guest in MOUNTS]
for host, _guest in MOUNTS:
    host.mkdir(parents=True, exist_ok=True)
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
        image=BASE_IMAGE,
        network_mode=NetworkMode.FULL,
        cpus=CPUS,
        memory=MEMORY,
        disk_size=DISK_SIZE,
        mounts=[Mount(str(INIT_MOUNT_DIR), "/mnt/init"), *CONFIGURED_MOUNTS],
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
    ssh_host_port = _available_ssh_port()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    SSH_PORT_PATH.write_text(f"{ssh_host_port}\n")
    atexit.register(SSH_PORT_PATH.unlink, missing_ok=True)
    VNC_PORT_PATH.unlink(missing_ok=True)
    atexit.register(VNC_PORT_PATH.unlink, missing_ok=True)
    print(f"SSH keypair: {KEY_PATH} (+ .pub)")
    print(f"Sandbox image: {IMAGE_NAME}")

    async with Sandbox(
        image=str(IMAGE_PATH),
        network_mode=NetworkMode.FULL,
        cpus=CPUS,
        memory=MEMORY,
        disk_size=DISK_SIZE,
        enable_display=ENABLE_DISPLAY,
        mounts=[Mount(str(MOUNT_DIR), "/data"), *CONFIGURED_MOUNTS],
        port_forwards=[Forward(Host(ssh_host_port), Guest(22)), *PORT_FORWARDS],
    ) as sb:
        if sb.vnc_port is not None:
            VNC_PORT_PATH.write_text(f"{sb.vnc_port}\n")
            await asyncio.sleep(2)
            await sb.screenshot(DESKTOP_SCREENSHOT_PATH)

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
        print(f"  SSH (key):  ssh -i {KEY_PATH} -p {ssh_host_port} root@127.0.0.1")
        print(f"  SSH (pw):   ssh -p {ssh_host_port} root@127.0.0.1          (password: root)")
        print(f"  Mount:      host {MOUNT_DIR} -> guest /data")
        print(f"  Port rule:  Host({ssh_host_port}) -> Guest(22) (automatic SSH)")
        if sb.vnc_port is not None:
            print(f"  Desktop VNC: vnc://127.0.0.1:{sb.vnc_port}")
            print(f"  Screenshot:  {DESKTOP_SCREENSHOT_PATH}")
        for source, source_port, destination, destination_port in PORT_MAPPINGS:
            print(f"  Port rule:  {source}({source_port}) -> {destination}({destination_port})")

        # Hold the sandbox open until the user is done
        try:
            await asyncio.to_thread(input, "Press Enter to stop the sandbox...")
        except EOFError:
            print("(non-interactive: holding sandbox open for 5 minutes)")
            await asyncio.sleep(300)
    SSH_PORT_PATH.unlink(missing_ok=True)
    VNC_PORT_PATH.unlink(missing_ok=True)

if ARGS.init:
    asyncio.run(init_image())
else:
    asyncio.run(main())
