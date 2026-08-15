/**
 * The stand-in for tx402's optional chain adapters. Added.
 *
 * `tx402` reaches its EVM and Solana adapters through lazy `import` from
 * `core/chain.ts`, which keeps `@x402/evm`, `@x402/svm`, `viem` and
 * `@solana/kit` out of a Node process that never pays. A bundler gets no such
 * benefit: esbuild resolves a dynamic import with a static specifier at BUILD
 * time, so without this alias every `wrangler deploy` fails on four optional
 * peers this repository deliberately does not install.
 *
 * Installing them instead would put EIP-3009 signing and Solana transaction building into a
 * repository that must never be able to construct a payment. So `wrangler.jsonc` aliases them here,
 * and every export throws. Nothing in this repository ever calls a chain adapter — the policy
 * engine, the challenge decoder, the spend ledger and the route ordering are all reachable without
 * one, and they are the whole of what these tools use.
 *
 * **CommonJS on purpose.** esbuild statically verifies named imports against an
 * ESM module and would reject this file for every symbol the adapters import,
 * of which there are dozens and they change between SDK releases. A CJS export
 * is resolved as a property access instead, so one Proxy covers all of them and
 * keeps covering them when tx402 adds another.
 */

const MESSAGE =
  "tools.tx402.io does not construct payments: tx402's chain adapters are not bundled.";

function refuse() {
  throw new Error(MESSAGE);
}

module.exports = new Proxy(
  { __esModule: true, default: refuse },
  {
    get(target, property) {
      if (property in target) return target[property];
      if (typeof property === "symbol") return undefined;
      return refuse;
    },
  },
);
