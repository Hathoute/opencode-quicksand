// Linux-host quirks for the ssh driver (see PlatformAdapter in driver.ts).
// Not implemented yet — members throw when invoked.

import type { GuestCommand, PathMap, PlatformAdapter } from "./driver"

const notImplemented = (what: string): never => {
  throw new Error(`${what} is not implemented for Linux hosts yet`)
}

export const linuxAdapter = (): PlatformAdapter => ({
  nullKnownHosts: "/dev/null",
  guestShell: (command, _args) => notImplemented(`guest shell translation for ${command}`),
  toGuestPath: (value, _map) => notImplemented(`host-to-guest path translation for ${value}`),
})
