#!/usr/bin/env node
/**
 * tx402-tools-mcp — MCP server over stdio.
 *
 * stdout is the JSON-RPC wire. Nothing but protocol frames is ever written
 * there; every diagnostic goes to stderr, where an MCP client shows it in its
 * server log. A stray line on stdout is a corrupt frame, and the client's
 * failure mode for that is a silent hang rather than an error.
 *
 * This process holds no keys, constructs no payment authorization, and cannot
 * spend anything. See the package README.
 */

import process from "node:process";

// A relative specifier, resolved against this module — no `URL` global, which
// `eslint.config.js` does not grant to `packages/**/bin/*.mjs` (its file, and
// not this change's to edit).
let server;
try {
  server = await import("../dist/packages/tools-mcp/src/stdio.js");
} catch (error) {
  process.stderr.write(
    "tx402-tools-mcp: the compiled server was not found.\n" +
      "  In a checkout of tx402-tools, build it first:\n" +
      "    pnpm --filter tx402-tools-mcp build\n" +
      `  (${error && error.message ? error.message : String(error)})\n`,
  );
  process.exit(1);
}

process.stdin.setEncoding("utf8");

await server.main(process.env, {
  stdin: process.stdin,
  write: (line) => process.stdout.write(line),
  log: (line) => process.stderr.write(`${line}\n`),
});
