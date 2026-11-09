// macOS-host quirks for the ssh driver (see PlatformAdapter in driver.ts).
// Identical to the Linux adapter: POSIX host paths, POSIX shells. Implemented
// by symmetry — not yet exercised on real macOS hardware.

import path from "path"
import type { GuestCommand, PathMap, PlatformAdapter } from "./driver"

/**
 * The shell tool resolves its shell against the macOS host (bash/zsh), so
 * invocations are already guest-compatible. Nothing to translate.
 */
const guestShell = (command: string, args: ReadonlyArray<string>): GuestCommand =>
  ({ command, args: [...args] })

// POSIX-to-POSIX mapping: case-sensitive prefix match on the host base,
// separators already "/". Values outside the base pass through as
// guest-native paths.
const toGuestPath = (value: string, map: PathMap): string => {
  const base = path.resolve(map.host)
  if (value !== base && !value.startsWith(base + path.sep)) return value
  const relative = value.slice(base.length).replace(/^[/\\]+/, "")
  return relative === "" ? map.guest : `${map.guest}/${relative.replaceAll(path.sep, "/")}`
}

export const macosAdapter = (): PlatformAdapter => ({
  nullKnownHosts: "/dev/null",
  guestShell,
  toGuestPath,
})
