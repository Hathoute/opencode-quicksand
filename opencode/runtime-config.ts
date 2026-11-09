import os from "node:os"
import path from "path"

export const loadRuntimeConfig = async (file: string) => {
  const configFile = path.resolve(file)
  const root = object(Bun.JSONC.parse(await Bun.file(configFile).text()), "config")
  const opencode = object(root.opencode, "opencode")
  const sandbox = object(root.sandbox, "sandbox")
  const base = path.dirname(configFile)
  return {
    file: configFile,
    opencode: {
      configDir: resolve(base, string(opencode.configDir, "opencode.configDir")),
      cacheDir: resolve(base, string(opencode.cacheDir, "opencode.cacheDir")),
      tag: string(opencode.tag, "opencode.tag"),
      port: port(opencode.port),
    },
    sandbox: {
      initScript: resolve(base, string(sandbox.initScript, "sandbox.initScript")),
      mountDir: resolve(base, string(sandbox.mountDir, "sandbox.mountDir")),
    },
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

function port(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error("opencode.port must be an integer between 1 and 65535")
  return value
}

function resolve(base: string, value: string) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2))
  return path.resolve(base, value)
}
