/**
 * The build.  owns this file, and this is the decision asked
 * this change to make and write down.
 *
 * ── Why a bundle rather than `tsc --outDir` ────────────────────────────────
 *
 * The CLI is a fourth renderer of one computation, not a fourth
 * implementation: `inspect` calls `buildData` from `worker/routes/inspect.ts`
 * and renders with `ui/pages/inspect/markdown.ts`, so a locally-probed report
 * is the same computation the hosted route performs and the same renderer
 * `Accept: text/markdown` serves (SPEC §1.2).
 *
 * That reuse drags one thing along that Node cannot execute. The Inspector's
 * HTML page asks `worker/routes/assets.ts` for a hashed asset URL, and that
 * module imports `ui/tokens.css` as text — which works because wrangler has a
 * `rules` entry for it, and does not work under `node dist/…js`, where a CSS
 * import is a hard error. `tsc` emits that import verbatim, so a plain
 * `--outDir` build produces a CLI that crashes on `import`.
 *
 * esbuild fixes it twice over: `.css` gets the `text` loader, and tree-shaking
 * removes the entire HTML-page subtree, which the CLI never calls. The result
 * is one self-contained ESM file with `tx402` left external, which is what a
 * published CLI should be anyway — `npm i -g tx402-tools` then pulls exactly
 * one dependency.
 *
 * `tx402` is external on purpose: the replay taxonomy
 * is built over the SDK's own `TX402_ERROR_CODES` so that an eighteenth error
 * code stops the build rather than being silently misclassified, and inlining
 * a copy would break that at the version boundary.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// Imported rather than reached for as a global: this file is outside the
// eslint block that declares Node globals, and importing them is the fix that
// does not require editing its `eslint.config.js`.
import { stdout } from "node:process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

const result = await build({
  entryPoints: [join(here, "src", "cli.ts")],
  outfile: join(here, "dist", "cli.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  // The package declares `engines.node: >=20` and means it. The repo's own
  // tooling needs 22 (wrangler refuses 20); a person installing the CLI must
  // not inherit that.
  target: "node20",
  external: Object.keys(pkg.dependencies ?? {}),
  loader: { ".css": "text" },
  legalComments: "none",
  minify: false,
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0].bytes;
stdout.write(`tx402-tools build ok — dist/cli.mjs ${(bytes / 1024).toFixed(1)} KiB\n`);
