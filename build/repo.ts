import { cpSync, existsSync, symlinkSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { CHECKOUT_DIR, DEFAULT_COMMIT, POC_DIR, REPO_URL } from "./common"

/** Clone (shallow, pinned commit) or reuse the opencode checkout. */
export const ensureRepo = async (commit: string = process.env.OPENCODE_COMMIT ?? DEFAULT_COMMIT) => {
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
    await $`git -C ${CHECKOUT_DIR} fetch --depth 1 origin ${commit}`.quiet()
    await $`git -C ${CHECKOUT_DIR} checkout --force FETCH_HEAD`.quiet()
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
  if (existsSync(effectTarget) && !existsSync(effectLink))
    symlinkSync(effectTarget, effectLink, "junction")
}
