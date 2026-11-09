import path from "path"

/** Project root (this file lives in build/). */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "..")
/** Platform-specific poc TypeScript sources, synced into the checkout. */
export const POC_DIR = path.join(PROJECT_ROOT, "opencode")
/** The opencode checkout (cloned/fetched at the pinned commit). */
export const CHECKOUT_DIR = path.join(PROJECT_ROOT, "build", "opencode")
/** Compiled executables land here. */
export const DIST_DIR = path.join(PROJECT_ROOT, "build", "dist")
/** The quicksand sandbox script + its venv and runtime state (data/, ssh/). */
export const SANDBOX_DIR = path.join(PROJECT_ROOT, "quicksand")
export const SANDBOX_VENV = path.join(SANDBOX_DIR, ".venv")
export const DATA_DIR = path.join(SANDBOX_DIR, "data")
export const SSH_KEY = path.join(SANDBOX_DIR, "ssh", "quicksand_demo")

export const DEFAULT_COMMIT = "ced73dc0f6c5b00c3a085b1d7b11ea31f790c5df"
export const REPO_URL = "https://github.com/anomalyco/opencode.git"

export const venvPython = (): string =>
  process.platform === "win32"
    ? path.join(SANDBOX_VENV, "Scripts", "python.exe")
    : path.join(SANDBOX_VENV, "bin", "python")

export const pythonExe = (): string => process.env.PYTHON ?? "python"
