// Linux-host quirks for the ssh driver (see PlatformAdapter in driver.ts).

import path from "path"
import type { GuestCommand, PathMap, PlatformAdapter } from "./driver"

/**
 * The shell tool resolves its shell against the Linux host, so it already
 * issues POSIX invocations (config shell=bash makes this explicit). Nothing
 * to translate — commands pass through to the guest unchanged.
 */
const guestShell = (command: string, args: ReadonlyArray<string>): GuestCommand =>
  ({ command, args: [...args] })

// Host and guest are both POSIX: case-sensitive prefix match on the host
// base, separators already "/". Values outside the base are guest-native
// paths and pass through untouched.
const toGuestPath = (value: string, map: PathMap): string => {
  const base = path.resolve(map.host)
  if (value !== base && !value.startsWith(base + path.sep)) return value
  const relative = value.slice(base.length).replace(/^[/\\]+/, "")
  return relative === "" ? map.guest : `${map.guest}/${relative.replaceAll(path.sep, "/")}`
}

export const linuxAdapter = (): PlatformAdapter => ({
  nullKnownHosts: "/dev/null",
  guestShell,
  toGuestPath,
})
