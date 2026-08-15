#!/usr/bin/env node
// Global gate: `pnpm gate:tokens`.
//   "UI drifts into seven visual dialects → We freeze ui/tokens.css and adds
//    a CI check that rejects a raw hex colour outside tokens.css."
// Scanned:
//   * every.css file except ui/tokens.css
//   * <style> blocks and style="…" attributes in.ts /.tsx /.html
// Rejected: #hex colours, rgb/rgba/hsl/hslb literals, and the CSS
// named colours that actually get typed by accident. Allowed: url(#id) SVG
// references, `currentColor`, `transparent`, and `color-mix(in srgb, var(…))`
// composed from tokens.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "dist", "coverage"]);

// The one file allowed to contain a raw colour.
const TOKENS_FILE = "ui/tokens.css";

// A favicon is loaded outside the document, so it cannot resolve a CSS custom
// property from an external stylesheet — it has to carry literal values. This
// is the only exemption, and it is a technical limit rather than a preference.
const EXEMPT = new Set(["public/favicon.svg"]);

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgba?|hsla?|lab|lch|oklab|oklch)\s*\(/;
const NAMED = /\b(?:color|background(?:-color)?|border(?:-[a-z]+)?-?color|fill|stroke|outline-color)\s*:\s*(?:red|blue|green|black|white|grey|gray|yellow|orange|purple|pink|cyan|magenta|silver|navy|teal|olive|maroon|lime|aqua|fuchsia)\b/i;

const hits = [];

function checkCss(rel, content, lineOffset = 0, context = "") {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    // url(#gradient-id) is an SVG reference, not a colour.
    const stripped = line.replace(/url\(\s*#[^)]*\)/g, "");
    if (HEX.test(stripped)) {
      hits.push({ rel, line: i + 1 + lineOffset, text: line.trim(), why: "hex colour", context });
    } else if (FUNC.test(stripped)) {
      hits.push({ rel, line: i + 1 + lineOffset, text: line.trim(), why: "colour function", context });
    } else if (NAMED.test(stripped)) {
      hits.push({ rel, line: i + 1 + lineOffset, text: line.trim(), why: "named colour", context });
    }
  }
}

function checkMarkup(rel, content) {
  // <style> … </style>
  for (const match of content.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const before = content.slice(0, match.index ?? 0);
    checkCss(rel, match[1] ?? "", before.split("\n").length - 1, "<style> block");
  }
  // style="…" and style={`…`}
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    for (const match of line.matchAll(/style\s*=\s*(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const decl = match[1] ?? match[2] ?? match[3] ?? "";
      const stripped = decl.replace(/url\(\s*#[^)]*\)/g, "");
      if (HEX.test(stripped) || FUNC.test(stripped) || NAMED.test(stripped)) {
        hits.push({ rel, line: i + 1, text: line.trim(), why: "inline style colour", context: "style attribute" });
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
    if (st.isDirectory()) {
      walk(abs);
      continue;
    }
    if (rel === TOKENS_FILE || EXEMPT.has(rel)) continue;

    if (rel.endsWith(".css")) {
      checkCss(rel, readFileSync(abs, "utf8"));
    } else if (/\.(ts|tsx|js|jsx|html|svg)$/.test(rel)) {
      const content = readFileSync(abs, "utf8");
      if (rel.endsWith(".svg")) checkCss(rel, content, 0, "svg");
      else checkMarkup(rel, content);
    }
  }
}

walk(root);

if (hits.length > 0) {
  console.error(`gate:tokens FAILED — every colour comes from ${TOKENS_FILE}.\n`);
  for (const h of hits) {
    console.error(`  ✗ ${h.rel}:${h.line}  (${h.why}${h.context ? `, ${h.context}` : ""})`);
    console.error(`      ${h.text.slice(0, 140)}`);
  }
  console.error(`\nAdd a token to ${TOKENS_FILE} and reference it with var(--name).`);
  console.error("Seven tools that each invent their own greys is seven visual dialects.");
  process.exit(1);
}

console.log(`gate:tokens ok — no raw colour outside ${TOKENS_FILE}.`);
