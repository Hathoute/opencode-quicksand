import path from "path"

/** Project root (this file lives in build/). */
export const PROJECT_ROOT = path.resolve(import.meta.dir, "..")
/** Platform-specific poc TypeScript sources, synced into the checkout. */
export const POC_DIR = path.join(PROJECT_ROOT, "opencode")
/** The opencode checkout (cloned/fetched at the pinned commit). */
export const CHECKOUT_DIR = path.join(PROJECT_ROOT, "build", "opencode")
/** Compiled executables land here. */
export const DIST_DIR = path.join(PROJECT_ROOT, "build", "dist")
/** The quicksand sandbox script + its runtime state (ssh/). */
export const SANDBOX_DIR = path.join(PROJECT_ROOT, "quicksand")
export const SSH_KEY = path.join(SANDBOX_DIR, "ssh", "quicksand_demo")

export const REPO_URL = "https://github.com/anomalyco/opencode.git"

/** Release-artifact platform slug: <os>-<arch> (windows-x64, linux-arm64, …). */
export const platformSlug = (): string => {
  const os =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux"
  return `${os}-${process.arch}`
}

/** Executable suffix on this host ("" on POSIX, ".exe" on Windows). */
export const exeSuffix = process.platform === "win32" ? ".exe" : ""

/** Guard: the uv-managed environment is the single source of Python tooling. */
export const ensureUv = (): void => {
  if (Bun.which("uv") !== null) return
  console.error(
    "uv is required but not on PATH — install it first: " +
      "https://docs.astral.sh/uv/getting-started/installation/",
  )
  process.exit(1)
}
