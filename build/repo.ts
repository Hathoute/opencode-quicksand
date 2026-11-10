import { cpSync, existsSync, symlinkSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { CHECKOUT_DIR, POC_DIR, PROJECT_ROOT, REPO_URL } from "./common"
import { config } from "./config"

const patches = [path.join(PROJECT_ROOT, "patches", "opencode", "resolve-module.patch")]

/** Clone (shallow, pinned commit) or reuse the opencode checkout. */
export const ensureRepo = async (commit: string = config.opencode.tag) => {
  if (!existsSync(path.join(CHECKOUT_DIR, ".git"))) {
    await $`git init ${CHECKOUT_DIR}`.quiet()
    await $`git -C ${CHECKOUT_DIR} remote add origin ${REPO_URL}`.quiet()
  }
  const head = await $`git -C ${CHECKOUT_DIR} rev-parse HEAD`
    .nothrow()
    .quiet()
    .text()
    .then((t) => t.trim())
    .catch(() => "")
  if (head !== commit) {
    await reversePatches()
    await $`git -C ${CHECKOUT_DIR} fetch --depth 1 origin ${commit}`.quiet()
    await $`git -C ${CHECKOUT_DIR} checkout --force FETCH_HEAD`.quiet()
  }
  await applyPatches()
}

const reversePatches = async () => {
  for (const patch of patches.toReversed()) {
    const check = await $`git -C ${CHECKOUT_DIR} apply --reverse --check ${patch}`.nothrow().quiet()
    if (check.exitCode === 0) await $`git -C ${CHECKOUT_DIR} apply --reverse ${patch}`.quiet()
  }
}

const applyPatches = async () => {
  for (const patch of patches) {
    const check = await $`git -C ${CHECKOUT_DIR} apply --check ${patch}`.nothrow().quiet()
    if (check.exitCode === 0) {
      await $`git -C ${CHECKOUT_DIR} apply ${patch}`.quiet()
      continue
    }
    const applied = await $`git -C ${CHECKOUT_DIR} apply --reverse --check ${patch}`.nothrow().quiet()
    if (applied.exitCode !== 0) throw new Error(`OpenCode patch does not apply cleanly: ${patch}`)
  }
}

/** Copy the poc TypeScript sources into <checkout>/poc. */
export const syncPoc = () => {
  const target = path.join(CHECKOUT_DIR, "poc")
  cpSync(POC_DIR, target, { recursive: true, force: true })
  return target
}

/** bun install + the `effect` junction (same trick as upstream packaging). */
export const ensureDeps = async () => {
  await $`bun install --frozen-lockfile`.cwd(CHECKOUT_DIR).quiet()
  const effectTarget = path.join(CHECKOUT_DIR, "packages", "sdk", "node_modules", "effect")
  const effectLink = path.join(CHECKOUT_DIR, "node_modules", "effect")
  if (existsSync(effectTarget) && !existsSync(effectLink)) symlinkSync(effectTarget, effectLink, "junction")
}
