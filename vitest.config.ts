import { defineConfig } from "vitest/config";

/**
 * Tests run in Node against the router's exported `handleRequest`, not inside
 * workerd.
 *
 * The reason is `pnpm schema:check`'s sibling: the router tests validate every
 * response against `spec/schemas/` with ajv, and ajv compiles validators with
 * `new Function`, which workerd refuses. Testing the real handler with a mock
 * Env gets the behaviour under test — routing, negotiation, envelopes, stubs —
 * without that constraint.
 *
 *  and will want real D1 and Durable Objects; that is the point at which
 * adding a second `@cloudflare/vitest-pool-workers` project earns its
 * complexity. Until something needs workerd, this stays fast.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        // wrangler.jsonc imports CSS as Text (its `rules` entry) so
        // ui/tokens.css can stay at the canonical path gives it.
        // Vite needs the same behaviour, and the alias has to run before
        // vite:css claims the id — vite:css returns an EMPTY default export
        // under SSR, which would let the assets route serve a zero-byte
        // stylesheet in tests while working fine in production.
        find: /^(.*\.css)$/,
        replacement: "$1?raw",
      },
    ],
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: false,
    // Vitest stubs every CSS import to an empty string unless this is on, and
    // its stub matches on the id regardless of the `?raw` query above.
    css: true,
  },
});
