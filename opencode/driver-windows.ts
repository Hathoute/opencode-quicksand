// Windows-host quirks for the ssh driver (see PlatformAdapter in driver.ts).

import path from "path"
import type { GuestCommand, PathMap, PlatformAdapter } from "./driver"

// NUL discards known_hosts on Windows OpenSSH (POSIX uses /dev/null).
const nullKnownHosts = "NUL"

/**
 * The shell tool resolves its shell against the Windows host, so it issues
 * powershell/cmd/git-bash invocations (with absolute Windows paths). Translate
 * those to the guest POSIX shell here. Scripts arriving via -Command pass
 * through verbatim: with config shell=bash the model writes POSIX commands,
 * so the payload is already shell-compatible.
 */
const guestShell = (command: string, args: ReadonlyArray<string>): GuestCommand => {
  const base = path.win32.basename(command).replace(/\.exe$/i, "").toLowerCase()
  if (base === "powershell" || base === "pwsh") {
    const at = args.indexOf("-Command")
    const script = at >= 0 ? args.slice(at + 1).join(" ") : args.join(" ")
    return { command: "bash", args: ["-c", script] }
  }
  if (base === "cmd") {
    const at = args.indexOf("/c")
    const script = at >= 0 ? args.slice(at + 1).join(" ") : args.join(" ")
    return { command: "bash", args: ["-c", script] }
  }
  if (base === "bash" || base === "sh" || base === "zsh" || base === "dash" || base === "ksh")
    return { command: base, args: [...args] }
  return { command, args: [...args] }
}

// Windows paths are case-insensitive and use \ separators: normalize before
// prefix-matching the host base, and convert separators on the way out.
const toGuestPath = (value: string, map: PathMap): string => {
  const base = path.resolve(map.host)
  const candidate = value.replaceAll("/", path.sep)
  const low = candidate.toLowerCase()
  const baseLow = base.toLowerCase()
  if (low !== baseLow && !low.startsWith(baseLow + path.sep)) return value
  const relative = candidate.slice(base.length).replace(/^[/\\]+/, "")
  return relative === "" ? map.guest : `${map.guest}/${relative.replaceAll(path.sep, "/")}`
}

export const windowsAdapter = (): PlatformAdapter => ({
  nullKnownHosts,
  guestShell,
  toGuestPath,
})
