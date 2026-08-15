#!/usr/bin/env node
// Global gate: `pnpm gate:no-signer`.
//   "The probe never pays. No signer, no key, no PAYMENT-SIGNATURE header is
//    ever constructed anywhere in this repo. If this repo can pay, it is a
//    custody and abuse liability. It cannot."
// The gate has two tiers, because "never mention a signer" and "never build
// one" are different claims and only the second is the actual rule:
//   CODE patterns — scanned in source directories only. These are the shapes
//                    of CONSTRUCTING a signature or holding key material.
//                    There is no allowlist. A hit fails the build.
//   GLOBAL patterns — scanned everywhere including docs. These are strings
//                    that should only ever appear in prose explaining that we
//                    do not do this, so documentation paths are exempt and
//                    source paths are not.
// The distinction matters: SPEC.md and SECURITY.md have to be able to say the
// words "PAYMENT-SIGNATURE" in order to promise we never build one.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();

/**
 * Only files git tracks are scanned.
 *
 * This gate is a statement about what is IN this repository, so an untracked
 * scratch file or anything .gitignore excludes is not its business — and
 * failing a build over a file that never ships is the fastest way to teach
 * someone to reach for `--no-verify`. Falls back to scanning everything when
 * git is unavailable, because a gate that silently checks nothing is worse
 * than a noisy one.
 */
let tracked = null;
try {
  tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean),
  );
} catch {
  tracked = null;
}
const isTracked = (rel) => tracked === null || tracked.has(rel);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "dist",
  "coverage",
  ".github",
]);

// Where executable code lives. Everything here is held to the strict rules.
const CODE_ROOTS = ["worker", "ui", "packages", "scripts", "test"];

// Prose that is allowed to NAME the things we refuse to build.
const PROSE_ALLOWLIST = new Set([
  "README.md",
  "SECURITY.md",
  "spec/SPEC.md",
  "docs/abuse-policy.md",
  "scripts/gate-no-signer.mjs",
]);
const PROSE_ALLOWED_DIRS = ["docs/"];

const CODE_PATTERNS = [
  { re: /\bprivate[_-]?key\b/i, why: "private key material" },
  { re: /\bsecret[_-]?key\b/i, why: "secret key material" },
  { re: /\bmnemonic\b|\bseed\s?phrase\b/i, why: "wallet seed material" },
  { re: /\bsignTypedData\b/, why: "EIP-712 signing" },
  { re: /\bsignMessage\b|\bsignTransaction\b/, why: "transaction signing" },
  { re: /\bcreateWalletClient\b|\bprivateKeyToAccount\b/, why: "wallet client construction" },
  { re: /\bKeypair\.(from|generate)\b/, why: "Solana keypair construction" },
  { re: /\bnew\s+Wallet\s*\(/, why: "wallet construction" },
  // Importing a signer TYPE for documentation is fine; constructing or
  // implementing one is not.
  { re: /\bimplements\s+(Evm|Solana)Signer\b/, why: "signer implementation" },
  { re: /\bsigners\s*:\s*\{/, why: "tx402 signers config — this repo has none to configure" },
];

const GLOBAL_PATTERNS = [
  { re: /PAYMENT-SIGNATURE/i, why: "the x402 payment signature header" },
  { re: /X-PAYMENT-SIGNATURE/i, why: "the deprecated payment signature header" },
];

const hits = [];

function isProseExempt(rel) {
  if (PROSE_ALLOWLIST.has(rel)) return true;
  return PROSE_ALLOWED_DIRS.some((d) => rel.startsWith(d));
}

function isCodePath(rel) {
  const top = rel.split("/")[0];
  return CODE_ROOTS.includes(top);
}

function scan(file, rel) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return; // binary or unreadable — nothing to construct a signature with
  }
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (isCodePath(rel)) {
      for (const { re, why } of CODE_PATTERNS) {
        if (re.test(line)) hits.push({ rel, line: i + 1, why, text: lines[i].trim() });
      }
    }

    if (!isProseExempt(rel)) {
      for (const { re, why } of GLOBAL_PATTERNS) {
        if (re.test(line)) hits.push({ rel, line: i + 1, why, text: lines[i].trim() });
      }
    }
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    const rel = relative(root, abs).split(sep).join("/");
    if (st.isDirectory()) walk(abs);
    else if (st.size < 2_000_000 && isTracked(rel)) scan(abs, rel);
  }
}

walk(root);

if (hits.length > 0) {
  console.error("gate:no-signer FAILED — this repo never constructs a payment.\n");
  for (const h of hits) {
    console.error(`  ✗ ${h.rel}:${h.line}  (${h.why})`);
    console.error(`      ${h.text.slice(0, 140)}`);
  }
  console.error(
    "\nIf this is prose explaining that we do NOT do this, add the file to PROSE_ALLOWLIST in",
  );
  console.error("scripts/gate-no-signer.mjs. If it is code, it does not belong in this repository.");
  process.exit(1);
}

console.log("gate:no-signer ok — no signer, no key material, no payment signature construction.");
