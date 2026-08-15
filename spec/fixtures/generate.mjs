#!/usr/bin/env node
// Regenerates the fixtures that are too large or too syntactically awkward to
// review as literals: the base64 wire forms, the oversized payload, the deeply
// nested payload, the duplicate-key text and the too-many-requirements list.
// The generator is committed alongside its output on purpose. A 70 KB blob of
// 'A's with no explanation is unreviewable; a fifteen-line generator that
// produces it is auditable, and re-running this must be a no-op:
//   node spec/fixtures/generate.mjs && git diff --exit-code spec/fixtures
// CI runs exactly that (see.github/workflows/ci.yml), so a fixture cannot be
// edited by hand without the generator being updated to match.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => JSON.parse(readFileSync(join(here, p), "utf8"));
const write = (p, s) => writeFileSync(join(here, p), s.endsWith("\n") ? s : `${s}\n`);
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

// ── wire forms: x402 v2 carries the challenge base64-encoded in a header ──
write("challenges/v2-header-valid.txt", b64(read("challenges/v2-header-valid.decoded.json")));
write("challenges/v2-dynamic-payto.txt", b64(read("challenges/v2-dynamic-payto.decoded.json")));

// Decodes cleanly from base64 and is then not JSON at all.
write("challenges/malformed-not-json.txt", Buffer.from("payment required, pay me", "utf8").toString("base64"));

// ── hostile: over the decoder's byte cap (MAX_PAYMENT_REQUIRED_BYTES = 64 KiB) ──
const oversized = read("challenges/v2-header-valid.decoded.json");
oversized.accepts[0].description = "A".repeat(70_000);
write("hostile/oversized.json", JSON.stringify(oversized));

// ── hostile: over the decoder's depth cap (MAX_PAYMENT_REQUIRED_DEPTH = 16) ──
const deep = read("challenges/v2-header-valid.decoded.json");
let node = { depth: 40 };
for (let i = 0; i < 40; i += 1) node = { nested: node };
deep.accepts[0].extra = node;
write("hostile/deep-nested.json", JSON.stringify(deep, null, 2));

// ── hostile: over the decoder's requirement cap (MAX_PAYMENT_REQUIREMENTS) ──
const many = read("challenges/v2-header-valid.decoded.json");
const one = many.accepts[0];
many.accepts = Array.from({ length: 200 }, (_, i) => ({ ...one, maxAmountRequired: String(1000 + i) }));
write("hostile/too-many-requirements.json", JSON.stringify(many));

// ── hostile: duplicate keys ──
// Cannot be produced by JSON.stringify — a JS object cannot hold two `payTo`
// keys — so it is assembled as text. Every mainstream parser accepts this and
// silently keeps the LAST value, which is the whole attack: a wallet and a
// human reading the same bytes can disagree about who is being paid.
write(
  "hostile/duplicate-keys.txt",
  [
    "{",
    '  "x402Version": 2,',
    '  "accepts": [',
    "    {",
    '      "scheme": "exact",',
    '      "network": "eip155:8453",',
    '      "maxAmountRequired": "1000",',
    '      "resource": "https://api.example.com/v1/geocode",',
    '      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",',
    '      "payTo": "0x000000000000000000000000000000000000dEaD",',
    '      "maxTimeoutSeconds": 300,',
    '      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"',
    "    }",
    "  ]",
    "}",
  ].join("\n"),
);

// ── hostile: not strict base64 ──
// Internal whitespace, a URL-safe alphabet character and broken padding. Any
// one of these is enough; a lenient decoder accepts all three.
write("hostile/bad-base64.txt", "eyJ4NDAy VmVyc2lv-bkI6IDJ9=====");

console.log("fixtures regenerated");
