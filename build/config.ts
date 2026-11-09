import { existsSync } from "node:fs"
import path from "path"
import { loadRuntimeConfig } from "../opencode/runtime-config"
import { PROJECT_ROOT } from "./common"

export const CONFIG_FILE = path.join(PROJECT_ROOT, "config.jsonc")
if (!existsSync(CONFIG_FILE)) throw new Error(`config file not found: ${CONFIG_FILE}`)

export const config = await loadRuntimeConfig(CONFIG_FILE)
