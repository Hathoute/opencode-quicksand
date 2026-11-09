"""Ubuntu sandbox demo:
- NetworkMode.FULL (internet access)
- mounts the directory it is RUN FROM (the caller's CWD) at /data in the VM;
  SANDBOX_MOUNT_DIR overrides this
- guest SSH (22) exposed on host 127.0.0.1:2222
- generates ./ssh/quicksand_demo next to the script (next to the exe when
  frozen) and injects the pubkey into the VM so opencode's ssh driver can
  log in non-interactively (BatchMode)
"""

import asyncio
import os
import subprocess
import sys
from pathlib import Path

from quicksand import Forward, Guest, Host, Mount, NetworkMode, Sandbox


def _mount_dir() -> Path:
    """Directory mounted at /data in the guest: the directory the sandbox is
    RUN FROM (the caller's CWD — identical semantics from source and the
    frozen exe). SANDBOX_MOUNT_DIR overrides when the launcher's CWD differs
    from the intended workspace (e.g. CI)."""
    if (override := os.environ.get("SANDBOX_MOUNT_DIR")) is not None:
        return Path(override)
    return Path.cwd()


def _script_dir() -> Path:
    """Where ssh/ keys live: next to this script. Frozen (PyInstaller onefile)
    __file__ points into the temp extraction dir, so use the exe's directory."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).parent


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


MOUNT_DIR = _mount_dir()
KEY_PATH = _script_dir() / "ssh" / "quicksand_demo"
patch_frozen_qemu()

SSH_SETUP = (
    "if ! command -v sshd >/dev/null 2>&1; then "
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server; fi && "
    "mkdir -p /run/sshd /etc/ssh/sshd_config.d /root/.ssh && "
    "printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/99-demo.conf && "
    "echo 'root:root' | sudo chpasswd && "
    "echo '{pubkey}' >> /root/.ssh/authorized_keys && "
    "chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys && "
    "(sudo service ssh restart || sudo service ssh start || sudo /usr/sbin/sshd) && "
    "ss -tln | grep ':22 ' && echo SSH-READY"
)


def ensure_keypair() -> str:
    """Generate an ed25519 keypair once; return the public key line."""
    KEY_PATH.parent.mkdir(exist_ok=True)
    if not KEY_PATH.exists():
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-q", "-f", str(KEY_PATH)],
            check=True,
        )
    return KEY_PATH.with_suffix(".pub").read_text().strip()


async def main():
    pubkey = ensure_keypair()
    print(f"SSH keypair: {KEY_PATH} (+ .pub)")

    async with Sandbox(
        image="ubuntu",
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

        # Set up and start the SSH server in the guest
        print("Setting up SSH server in guest (installs openssh-server if missing)...")
        r = await sb.execute(SSH_SETUP.format(pubkey=pubkey), timeout=300)
        if "SSH-READY" not in r.stdout:
            print("SSH setup FAILED:")
            print(r.stdout)
            print(r.stderr)
            return

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

asyncio.run(main())
