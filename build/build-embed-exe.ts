/** Compiles the embedder into a standalone executable (build/dist/embed.exe). */

import path from "path"
import { mkdirSync, renameSync } from "node:fs"
import { $ } from "bun"
import { CHECKOUT_DIR, DIST_DIR } from "./common"
import { ensureDeps, ensureRepo, syncPoc } from "./repo"

await ensureRepo()
const poc = syncPoc()
await ensureDeps()
mkdirSync(DIST_DIR, { recursive: true })
console.log(`poc synced -> ${poc}`)

const result = await Bun.build({
  entrypoints: [path.join(CHECKOUT_DIR, "poc", "embed.ts")],
  target: "bun",
  compile: true,
  // Bun compile uses only the basename of `outfile` (directories are dropped),
  // so build at the process cwd and move into DIST_DIR afterwards.
  outfile: "embed.exe",
  plugins: [
    {
      name: "quicksand-compile-stubs",
      setup(build) {
        // Replace the pty package's runtime platform-package resolve with an
        // embedded binary: Bun extracts `with { type: "file" }` assets from
        // compiled executables to a real path at runtime. Windows-targeted
        // (the win32 binary path is hard-coded in the shim).
        build.onLoad(
          {
            // bun's .bun store dirs are "@opencode-ai+pty@<ver>"; hoisted layouts
            // are "@opencode-ai/pty/"
            filter: /@opencode-ai\+pty@|@opencode-ai[\\\/]pty[\\\/]/,
          },
          () =>
            stub(
              'import binaryFile from "@opencode-ai/pty-win32-x64/bin/opencode-pty.exe" with { type: "file" };\nexport const binaryPath = binaryFile;',
            ),
        )
        // The tree-sitter wasm resolver needs files on disk; empty paths make
        // the shell tool fall back to the portable scanner (no wasm).
        build.onLoad({ filter: /parser-wasm\.node\.ts$/ }, () =>
          stub('export const shellParserWasm = { runtime: "", bash: "", powershell: "" }'),
        )
      },
    },
  ],
})

if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}
mkdirSync(DIST_DIR, { recursive: true })
const built = path.resolve("embed.exe")
const final = path.join(DIST_DIR, "embed.exe")
renameSync(built, final)
for (const output of result.outputs) console.log(`built: ${output.path}`)
console.log(`moved: ${final}`)

function stub(contents: string) {
  return { contents, loader: "ts" as const }
}
