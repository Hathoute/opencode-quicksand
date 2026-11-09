/** Compiles the embedder into a standalone executable
 * (build/dist/embed-<os>-<arch>[.exe]).
 *
 * Target: EMBED_TARGET env var or first CLI arg — windows-x64 | linux-x64 |
 * linux-arm64 | macos-arm64 (default: the current platform). Bun compiles for
 * any target from any host, so one Linux CI job can produce all of them.
 *
 * The pty native binary for the TARGET platform is embedded the same way
 * upstream opencode does it (packages/cli/script/build.ts): force-install
 * every platform variant of @opencode-ai/pty, then replace core's
 * pty-binding.ts with a `with { type: "file" }` asset import — the package's
 * own runtime require.resolve() could never work inside a compiled binary. */

import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import path from "path"
import { $ } from "bun"
import { CHECKOUT_DIR, DIST_DIR } from "./common"
import { ensureDeps, ensureRepo, syncPoc } from "./repo"

const ALLOWED_TARGETS = ["windows-x64", "linux-x64", "linux-arm64", "macos-arm64"] as const
type Target = (typeof ALLOWED_TARGETS)[number]

const hostSlug = (): string =>
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"

const requested = process.env.EMBED_TARGET ?? process.argv[2] ?? `${hostSlug()}-${process.arch}`
const target = requested.replace(/^bun-/, "") as Target
if (!ALLOWED_TARGETS.includes(target))
  throw new Error(`unknown target "${requested}" (allowed: ${ALLOWED_TARGETS.join(", ")})`)

// ---- checkout + deps first (the pty resolution below reads the checkout) ----

await ensureRepo()
const poc = syncPoc()
await ensureDeps()
mkdirSync(DIST_DIR, { recursive: true })
console.log(`poc synced -> ${poc}`)

// ---- pty binary for the TARGET platform (upstream's resolveOpencodePty) ----

const ptyPlatform = target.startsWith("windows")
  ? "win32"
  : target.startsWith("macos")
    ? "darwin"
    : "linux"
const ptyArch = target.split("-")[1] as "x64" | "arm64"
const ptySuffix = [ptyPlatform, ptyArch, ptyPlatform === "linux" ? "gnu" : undefined]
  .filter(Boolean)
  .join("-")
const ptyName = `@opencode-ai/pty-${ptySuffix}`
const corePkgPath = path.join(CHECKOUT_DIR, "packages", "core", "package.json")
const coreRequire = createRequire(corePkgPath)
const ptyVersion =
  JSON.parse(readFileSync(corePkgPath, "utf8")).dependencies["@opencode-ai/pty"] as string

// Bun skips other-platform natives by default; install every variant of the
// pinned version (run from packages/core, which already declares the dep —
// same as upstream, so nothing is added to any manifest). The flags are
// interpolated (not literal) so Bun's shell does not glob-expand the `*`.
await $`bun install ${["--os=*", "--cpu=*", "--libc=*"]} ${ptyName}@${ptyVersion}`
  .cwd(path.join(CHECKOUT_DIR, "packages", "core"))
  .quiet()

const ptyDir = path.dirname(coreRequire.resolve(`${ptyName}/package.json`))
const ptyBin = path.join(ptyDir, "bin", ptyPlatform === "win32" ? "opencode-pty.exe" : "opencode-pty")
const ptySha256 = createHash("sha256").update(readFileSync(ptyBin)).digest("hex")

console.log(`target ${target} (pty: ${ptyName}@${ptyVersion})`)

const exeSuffix = target.startsWith("windows") ? ".exe" : ""
const final = path.join(DIST_DIR, `embed-${target}${exeSuffix}`)
const compileTarget = target.startsWith("macos-") ? target.replace(/^macos-/, "darwin-") : target

const result = await Bun.build({
  entrypoints: [path.join(CHECKOUT_DIR, "poc", "embed.ts")],
  target: "bun",
  // Plain compile: the executable embeds the JS source and runs it with the
  // JIT. `bytecode: true` is deliberately OFF — on Bun 1.4.4 this entry
  // compiles fine but the executable becomes a silent no-op (exits 0 doing
  // nothing, even with minify off; top-level await in the dependency graph,
  // e.g. @ff-labs/fff-bun, is the prime suspect). Bun's experimental
  // machine-code AOT (`compile: { aot: true }`) is also out: it only builds
  // for the host platform and type-check-gates the whole checkout.
  compile: {
    // cross-compile target (bun-windows-x64 / bun-linux-x64 /
    // bun-linux-arm64 / bun-darwin-arm64);
    // omitting it compiles for the host platform. outfile MUST be absolute —
    // a relative value is silently ignored and no executable is produced.
    target: `bun-${compileTarget}` as Bun.Build.CompileTarget,
    outfile: final,
  },
  plugins: [
    {
      name: "quicksand-compile-stubs",
      setup(build) {
        // Embed the target platform's pty binary as a compiled asset (see
        // header). Mirrors upstream's opencode-pty-binary plugin.
        build.onLoad({ filter: /persistent-pty[/\\]pty-binding\.ts$/ }, () => ({
          loader: "js",
          contents:
            `import file from ${JSON.stringify(ptyBin)} with { type: "file" }\n` +
            `export default { path: file, version: ${JSON.stringify(ptyVersion)}, sha256: ${JSON.stringify(ptySha256)} }`,
        }))
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
// Bun.build can report success without emitting the executable (e.g. when an
// outfile form is ignored) — verify the artifact before declaring victory.
if (!existsSync(final)) {
  console.error(`compile reported success but ${final} does not exist`)
  process.exit(1)
}
console.log(`built: ${final}`)

function stub(contents: string) {
  return { contents, loader: "ts" as const }
}
