import os from "node:os"
import path from "path"

export const loadRuntimeConfig = async (file: string) => {
  const configFile = path.resolve(file)
  const root = object(Bun.JSONC.parse(await Bun.file(configFile).text()), "config")
  const opencode = object(root.opencode, "opencode")
  const sandbox = object(root.sandbox, "sandbox")
  const portMapping = array(sandbox.portMapping, "sandbox.portMapping").map((value, index) => {
    const mapping = object(value, `sandbox.portMapping[${index}]`)
    return {
      from: endpoint(mapping.from, `sandbox.portMapping[${index}].from`),
      to: endpoint(mapping.to, `sandbox.portMapping[${index}].to`),
    }
  })
  const mounts = array(sandbox.mounts ?? [], "sandbox.mounts").map((value, index) => {
    const mount = object(value, `sandbox.mounts[${index}]`)
    const guest = string(mount.guest, `sandbox.mounts[${index}].guest`)
    if (!guest.startsWith("/")) throw new Error(`sandbox.mounts[${index}].guest must be an absolute guest path`)
    if (guest === "/data" || guest === "/mnt/init")
      throw new Error(`sandbox.mounts[${index}].guest conflicts with reserved mount ${guest}`)
    return {
      host: resolve(path.dirname(configFile), string(mount.host, `sandbox.mounts[${index}].host`)),
      guest,
    }
  })
  const environment = object(sandbox.env ?? {}, "sandbox.env")
  const env = Object.fromEntries(
    Object.entries(environment).map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`sandbox.env has invalid variable name: ${key}`)
      if (typeof value !== "string") throw new Error(`sandbox.env.${key} must be a string`)
      return [key, value]
    }),
  )
  const base = path.dirname(configFile)
  return {
    file: configFile,
    opencode: {
      configDir: resolve(base, string(opencode.configDir, "opencode.configDir")),
      cacheDir: resolve(base, string(opencode.cacheDir, "opencode.cacheDir")),
      tag: string(opencode.tag, "opencode.tag"),
      port: port(opencode.port, "opencode.port"),
    },
    sandbox: {
      image: string(sandbox.image ?? "ubuntu", "sandbox.image"),
      imageTag: imageTag(sandbox.imageTag ?? "default", "sandbox.imageTag"),
      cpus: positiveInteger(sandbox.cpus ?? 1, "sandbox.cpus"),
      memory: string(sandbox.memory ?? "512M", "sandbox.memory"),
      diskSize: string(sandbox.diskSize ?? "10G", "sandbox.diskSize"),
      enableDisplay: boolean(sandbox.enableDisplay ?? false, "sandbox.enableDisplay"),
      initScript: resolve(base, string(sandbox.initScript, "sandbox.initScript")),
      cacheDir: resolve(base, string(sandbox.cacheDir, "sandbox.cacheDir")),
      mounts,
      env,
      portMapping,
    },
  }
}

interface PortEndpoint {
  readonly type: "host" | "guest"
  readonly port: number
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value as Record<string, unknown>
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`)
  return value
}

function port(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65_535)
    throw new Error(`${name} must be an integer between 1 and 65535`)
  return value
}

function positiveInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function imageTag(value: unknown, name: string) {
  const text = string(value, name)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text))
    throw new Error(
      `${name} must start with an alphanumeric character and contain only letters, digits, '.', '_', or '-'`,
    )
  return text
}

function endpoint(value: unknown, name: string): PortEndpoint {
  const text = string(value, name)
  const match = /^(Host|Guest)\(([0-9]+)\)$/.exec(text)
  if (!match) throw new Error(`${name} must use Host(<port>) or Guest(<port>)`)
  return {
    type: match[1] === "Host" ? "host" : "guest",
    port: port(Number(match[2]), name),
  }
}

function resolve(base: string, value: string) {
  if (value === "~") return os.homedir()
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2))
  return path.resolve(base, value)
}
