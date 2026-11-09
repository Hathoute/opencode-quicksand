import { existsSync } from "node:fs"
import path from "path"
import { loadRuntimeConfig } from "../opencode/runtime-config"
import { PROJECT_ROOT } from "./common"

const argument = process.argv.indexOf("--config")
if (argument !== -1 && process.argv[argument + 1] === undefined) throw new Error("--config requires a file path")
export const CONFIG_FILE = path.resolve(
  argument === -1 ? path.join(PROJECT_ROOT, "config.jsonc") : process.argv[argument + 1],
)
export const WORKSPACE_DIR = process.cwd()
if (!existsSync(CONFIG_FILE)) throw new Error(`config file not found: ${CONFIG_FILE}`)

export const config = await loadRuntimeConfig(CONFIG_FILE)
