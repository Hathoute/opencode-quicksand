/** Builds the sandbox VM launcher as a standalone directory + zip
 * (build/dist/sandbox-<os>-<arch>/: interpreter + deps + Ubuntu image + QEMU
 * binaries, via PyInstaller in the uv-managed build environment
 * (pyproject.toml `build` dependency-group). --onedir rather than --onefile:
 * a onefile exe executes bundled QEMU binaries out of %TEMP%, which policy
 * blocks on many Windows machines (WinError 1260). */

import { renameSync, rmSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { DIST_DIR, PROJECT_ROOT, SANDBOX_DIR, ensureUv, platformSlug } from "./common"

ensureUv()

// Runtime deps + the pyinstaller build group, exactly as locked.
await $`uv sync --frozen --group build`.cwd(PROJECT_ROOT)

// PyPI caps wheels at 100 MB, so quicksand publishes pure-Python stubs there
// and the fat wheels (Ubuntu qcow2/kernel/initrd, QEMU binaries) on its own
// simple index. A fresh build environment only has the stubs — without
// warming, the exe would collect no image/QEMU data (release v0.0.3 shipped
// 30-60 MB exes that cannot boot). quicksand's own runtime auto-install would
// fix this from source, but it shells out [sys.executable, -m, pip, ...],
// which in a frozen exe re-runs sandbox.exe itself. Warm HERE instead:
// force-reinstall every installed contrib package against the quicksand
// index so the fat wheels are on disk when PyInstaller collects.
const PROBE = `
from importlib.metadata import version
from quicksand_core._index import QUICKSAND_INDEX_URL
import pathlib
print(QUICKSAND_INDEX_URL)
print(pathlib.Path(__import__("quicksand_ubuntu").__file__).parent)
for name in ("quicksand-ubuntu", "quicksand-qemu", "quicksand-smb", "quicksand-ubuntu-desktop"):
    try:
        print(name, version(name))
    except Exception:
        pass
`
const probe = Bun.spawnSync([
  "uv",
  "run",
  "--no-sync",
  "--project",
  PROJECT_ROOT,
  "python",
  "-c",
  PROBE,
])
// python's print emits \r\n on Windows — strip both, or pip receives
// requirements like "quicksand-ubuntu==0.10.2\r" and finds no versions.
const lines = probe.stdout
  .toString()
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "")
if (probe.exitCode !== 0 || lines.length < 2) {
  console.error(probe.stderr.toString())
  throw new Error("could not probe the quicksand index/versions in the build environment")
}
const indexUrl = lines[0]
const ubuntuPackageDir = lines[1]
const packages = lines.slice(2).map((line) => line.split(" ")).filter((fields) => fields.length === 2)

for (const [name, ver] of packages) {
  console.log(`warming ${name}==${ver} from the quicksand index ...`)
  const pip = Bun.spawnSync([
    "uv",
    "run",
    "--no-sync",
    "--project",
    PROJECT_ROOT,
    "python",
    "-m",
    "pip",
    "install",
    "--force-reinstall",
    "--no-deps",
    "--index-url",
    indexUrl,
    `${name}==${ver}`,
  ])
  if (pip.exitCode !== 0) {
    console.error(
      `warning: ${name} fat wheel missing for this platform (pip exit ${pip.exitCode}) — ` +
        "the exe stays slim for it:\n" +
        (pip.stderr.toString() || pip.stdout.toString()).split("\n").slice(-5).join("\n"),
    )
  }
}

// Verify the essential image data actually landed: the stub is ~4 KB, the
// fat wheel carries a ~250 MB qcow2. Without this check a warmed-nothing
// build would silently ship a bootloader-only exe.
const sizeProbe = Bun.spawnSync([
  "uv",
  "run",
  "--no-sync",
  "--project",
  PROJECT_ROOT,
  "python",
  "-c",
  `import pathlib; print(sum(f.stat().st_size for f in pathlib.Path(r"${ubuntuPackageDir.replace(/\\/g, "\\\\")}").rglob("*") if f.is_file()))`,
])
const ubuntuBytes = Number(sizeProbe.stdout.toString().trim())
if (!Number.isFinite(ubuntuBytes) || ubuntuBytes < 100 * 1024 * 1024)
  throw new Error(
    `quicksand_ubuntu still holds only ${ubuntuBytes} bytes after warming — ` +
      "refusing to build an exe without the VM image (see the pip warnings above)",
  )
console.log(`warmed quicksand_ubuntu: ${(ubuntuBytes / 1024 / 1024).toFixed(1)} MB of image data on disk`)

await $`uv run --no-sync --project ${PROJECT_ROOT} pyinstaller --noconfirm --onedir --name sandbox --distpath ${DIST_DIR} --workpath ${path.join(DIST_DIR, "pyinstaller-work")} --specpath ${SANDBOX_DIR} --collect-all quicksand --collect-all quicksand_core --collect-all quicksand_qemu --collect-all quicksand_ubuntu --collect-all quicksand_smb --copy-metadata quick-sandbox --copy-metadata quicksand-core --copy-metadata quicksand-qemu --copy-metadata quicksand-ubuntu --copy-metadata quicksand-smb ${path.join(SANDBOX_DIR, "sandbox.py")}`

// --onedir over --onefile: a onefile exe extracts itself (and every bundled
// QEMU binary/DLL) into %TEMP% before executing them, which corporate policy
// blocks with WinError 1260 (ERROR_ACCESS_DISABLED_BY_POLICY). A onedir build
// keeps everything in a real directory and runs it in place — nothing is ever
// executed from temp. PyInstaller appends .exe only on Windows; release
// artifacts carry a platform suffix so every target can live together.
const builtDir = path.join(DIST_DIR, "sandbox")
const finalDir = path.join(DIST_DIR, `sandbox-${platformSlug()}`)
rmSync(finalDir, { recursive: true, force: true })
renameSync(builtDir, finalDir)

// Ship the folder as one zip; consumers extract it anywhere and run the
// launcher inside (no self-extraction step, nothing lands in %TEMP%).
const zip = path.join(DIST_DIR, `sandbox-${platformSlug()}.zip`)
rmSync(zip, { force: true })
await $`uv run --no-sync --project ${PROJECT_ROOT} python -m zipfile -c ${zip} ${finalDir}`
console.log(`built: ${finalDir}`)
console.log(`zipped: ${zip}`)
