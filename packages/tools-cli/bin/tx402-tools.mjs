#!/usr/bin/env node
// The bin entry. Deliberately three lines of logic: everything testable lives
// in `run`, which takes an argv slice and its output sinks as parameters, so
// the test suite drives the real dispatch without a process.
// `dist/cli.mjs` is one bundled ESM file with `tx402` left external. See. /build.mjs for why this is a bundle
// and not a `tsc --outDir` tree.

import { run } from "../dist/cli.mjs";

process.exitCode = await run(process.argv.slice(2));
