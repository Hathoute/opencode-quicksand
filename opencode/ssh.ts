/** SSH connection mechanics shared by the embedder and the workspace driver:
 * target identity, per-invocation argument assembly (including the host-key
 * verification tweak) and boot-time host-key pinning. Guest command
 * translation and the spawner stay in driver.ts. */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "path"

export interface SshTarget {
  host: string
  port: number
  user: string
  /** path to an OpenSSH private key (BatchMode: no password prompts) */
  keyFile: string
}

/**
 * Where the boot's host key is pinned: beside the identity. The embedder
 * writes it at boot (pinHostKey); the driver picks it up per invocation
 * (sshArgs) — they communicate through this file convention.
 */
export const knownHostsPath = (target: SshTarget): string | undefined =>
  target.keyFile === "" ? undefined : path.join(path.dirname(target.keyFile), "known_hosts")

/** entries for both spellings of the host so either target name verifies */
const toEntries = (lines: string[], port: number) =>
  lines
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))
    .flatMap((line) => {
      const rest = line.split(" ").slice(1).join(" ")
      return [`[localhost]:${port} ${rest}`, `[127.0.0.1]:${port} ${rest}`]
    })

/**
 * Pin the sandbox's host key at every boot: write it next to the identity so
 * the driver's ssh invocations verify silently. With the previous
 * UserKnownHostsFile=<null> accept-and-discard setup, ssh printed "Warning:
 * Permanently added …" into stderr on EVERY tool call. Always re-pin (the VM
 * generates fresh host keys per boot); when the sandbox is not listening,
 * remove a stale file so the driver falls back to accept-and-discard instead
 * of failing verification against a key that no longer exists.
 *
 * Returns the pinned file path, or undefined when no identity is configured.
 */
export const pinHostKey = (target: SshTarget): string | undefined => {
  const knownHosts = knownHostsPath(target)
  if (knownHosts === undefined) return undefined
  // Scan the forward's literal bind address, not the configured host name:
  // "localhost" often resolves to ::1 first (Linux default), the port forward
  // listens on 127.0.0.1 only, and ssh-keyscan — unlike the ssh client — does
  // not fall back across address families, so scanning "localhost" yields
  // nothing and every driver call pays the accept-and-discard warning.
  const scanHost = target.host === "localhost" ? "127.0.0.1" : target.host
  const scan = Bun.spawnSync(["ssh-keyscan", "-p", String(target.port), "-t", "ed25519,rsa", scanHost])
  let keys = toEntries(scan.stdout.toString().split("\n"), target.port)
  if (keys.length === 0) {
    // Windows OpenSSH's ssh-keyscan uses a restricted KEX list and cannot
    // negotiate with OpenSSH 9.6+ guests whose preferred method is
    // sntrup761x25519 ("choose_kex: unsupported KEX method") — while the ssh
    // client itself negotiates fine. Fall back to a throwaway login that
    // records the host key into the target known_hosts, then normalize it for
    // both host names.
    Bun.spawnSync([
      "ssh",
      "-T",
      "-x",
      "-i",
      target.keyFile,
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      `UserKnownHostsFile=${knownHosts}`,
      "-p",
      String(target.port),
      `${target.user}@${scanHost}`,
      "--",
      "true",
    ])
    if (existsSync(knownHosts)) keys = toEntries(readFileSync(knownHosts, "utf8").split("\n"), target.port)
  }
  if (keys.length > 0) {
    writeFileSync(knownHosts, keys.join("\n") + "\n")
    console.log(`host key pinned: ${knownHosts} (${keys.length} entries)`)
    return knownHosts
  }
  rmSync(knownHosts, { force: true })
  console.log(
    `ssh-keyscan got no host key from ${target.host}:${target.port} (sandbox down?); ` +
      "driver will accept-and-discard (expect the added-host warning)",
  )
  return undefined
}

/**
 * Argument list for one ssh invocation, ending with the remote command line.
 * Host-key verification: verify silently against the pinned known_hosts when
 * it exists; without the file (embedder started before the sandbox)
 * accept-and-discard, which prints "Warning: Permanently added …" into stderr
 * on every invocation because the null file cannot store anything.
 */
export const sshArgs = (target: SshTarget, nullKnownHosts: string, remote: string): string[] => {
  const knownHosts = knownHostsPath(target)
  const hostKeyArgs =
    knownHosts !== undefined && existsSync(knownHosts)
      ? ["-o", `UserKnownHostsFile=${knownHosts}`, "-o", "StrictHostKeyChecking=yes"]
      : ["-o", "StrictHostKeyChecking=no", "-o", `UserKnownHostsFile=${nullKnownHosts}`]
  return [
    "ssh",
    "-T",
    "-x",
    "-i",
    target.keyFile,
    "-o",
    "BatchMode=yes",
    ...hostKeyArgs,
    "-p",
    String(target.port),
    `${target.user}@${target.host}`,
    "--",
    remote,
  ]
}
