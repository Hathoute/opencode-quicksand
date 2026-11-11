/** Builds the sandbox VM launcher as a standalone directory + zip
 * (build/dist/sandbox-<os>-<arch>/: interpreter + deps + QEMU binaries — the
 * VM base image is NOT bundled, it comes from sandbox.image at runtime — via
 * PyInstaller in the uv-managed build environment (pyproject.toml `build`
 * dependency-group). --onedir rather than --onefile: a onefile exe executes
 * bundled QEMU binaries out of %TEMP%, which policy blocks on many Windows
 * machines (WinError 1260). */

import { renameSync, rmSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { DIST_DIR, PROJECT_ROOT, SANDBOX_DIR, ensureUv, platformSlug } from "./common"

ensureUv()

// Runtime deps + the pyinstaller build group, exactly as locked.
await $`uv sync --frozen --group build`.cwd(PROJECT_ROOT)

// PyPI caps wheels at 100 MB, so quicksand publishes pure-Python stubs there
// and the fat wheels (QEMU binaries; VM images) on its own simple index. The
// VM base image is NOT bundled: it is provided at runtime via sandbox.image
// (a provider name whose fat wheel is installed in the environment, or a
// path to a qcow2 — see _register_image_file in sandbox.py). QEMU itself is
// required by every boot, so its fat wheel is warmed here: force-reinstall
// against the quicksand index so PyInstaller embeds the real binaries.
// quicksand's runtime auto-install would do this from source, but it shells
// out [sys.executable, -m, pip, ...], which in a frozen exe re-runs
// sandbox.exe itself.
const PROBE = `
from importlib.metadata import version
from quicksand_core._index import QUICKSAND_INDEX_URL
import pathlib
print(QUICKSAND_INDEX_URL)
print(pathlib.Path(__import__("quicksand_qemu").__file__).parent)
for name in ("quicksand-qemu", "quicksand-smb"):
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
// requirements like "quicksand-qemu==0.5.12\r" and finds no versions.
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
const qemuPackageDir = lines[1]
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
    if (name === "quicksand-qemu") {
      console.error((pip.stderr.toString() || pip.stdout.toString()).split("\n").slice(-5).join("\n"))
      throw new Error("quicksand-qemu fat wheel missing — without QEMU the exe cannot boot a VM")
    }
    console.error(
      `warning: ${name} fat wheel missing for this platform (pip exit ${pip.exitCode}) — ` +
        "the exe stays slim for it:\n" +
        (pip.stderr.toString() || pip.stdout.toString()).split("\n").slice(-5).join("\n"),
    )
  }
}

// Verify the essential QEMU binaries actually landed: the stub is ~4 KB, the
// fat wheel carries qemu-img/qemu-system plus their DLLs/ROMs. Without this
// check a warmed-nothing build would silently ship an exe that cannot boot.
const qemuCheck = Bun.spawnSync([
  "uv",
  "run",
  "--no-sync",
  "--project",
  PROJECT_ROOT,
  "python",
  "-c",
  `import pathlib; d = pathlib.Path(r"${qemuPackageDir.replace(/\\/g, "\\\\")}"); ` +
    `bins = [f for f in d.rglob("*") if f.is_file() and (f.name.startswith("qemu-img") or f.name.startswith("qemu-system"))]; ` +
    `print(len(bins), sum(f.stat().st_size for f in d.rglob("*") if f.is_file()))`,
])
const [qemuBinCount, qemuBytes] = qemuCheck.stdout.toString().trim().split(/\s+/).map(Number)
if (qemuBinCount < 1)
  throw new Error(
    "no qemu-img/qemu-system binaries found in quicksand_qemu after warming — " +
      "refusing to build an exe that cannot boot a VM (see the pip warnings above)",
  )
console.log(`warmed quicksand_qemu: ${qemuBinCount} qemu binaries, ${(qemuBytes / 1024 / 1024).toFixed(1)} MB on disk`)

await $`uv run --no-sync --project ${PROJECT_ROOT} pyinstaller --noconfirm --onedir --name sandbox --distpath ${DIST_DIR} --workpath ${path.join(DIST_DIR, "pyinstaller-work")} --specpath ${SANDBOX_DIR} --collect-all quicksand --collect-all quicksand_core --collect-all quicksand_qemu --collect-all quicksand_smb --collect-all fastapi --collect-all uvicorn --copy-metadata quick-sandbox --copy-metadata quicksand-core --copy-metadata quicksand-qemu --copy-metadata quicksand-smb ${path.join(SANDBOX_DIR, "sandbox.py")}`

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
