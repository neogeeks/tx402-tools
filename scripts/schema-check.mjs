#!/usr/bin/env node
// Global gate: `pnpm schema:check`.
// 1. Every schema in spec/schemas/ compiles against JSON Schema 2020-12.
// 2. Every fixture in spec/fixtures/index.json validates against its declared
//    schema with its declared expectation.
// 3. Every fixture file on disk appears in the manifest, and every manifest
//    entry exists on disk. An unlisted fixture is a fixture nobody checks.
// Expectations are two-sided on purpose: an `invalid` fixture that starts
// passing is a schema regression and fails the gate just as loudly as a
// `valid` fixture that starts failing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = process.cwd();
const schemasDir = join(root, "spec", "schemas");
const fixturesDir = join(root, "spec", "fixtures");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const failures = [];
const fail = (msg) => failures.push(msg);

// ── 1. compile every schema ──────────────────────────────────────────────
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
addFormats(ajv);

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".json")).sort();
if (schemaFiles.length === 0) fail("spec/schemas/ is empty");

const byName = new Map();
for (const file of schemaFiles) {
  const schema = readJson(join(schemasDir, file));
  const name = file.replace(/\.json$/, "");
  if (!schema.$id) fail(`spec/schemas/${file}: missing $id`);
  const expectedId = `https://tools.tx402.io/api/v1/schemas/${name}`;
  if (schema.$id !== expectedId) {
    fail(`spec/schemas/${file}: $id is ${schema.$id}, expected ${expectedId}`);
  }
  try {
    ajv.addSchema(schema, schema.$id);
    byName.set(name, schema.$id);
  } catch (err) {
    fail(`spec/schemas/${file}: ${err.message}`);
  }
}

const validators = new Map();
for (const [name, id] of byName) {
  try {
    validators.set(name, ajv.getSchema(id) ?? ajv.compile(readJson(join(schemasDir, `${name}.json`))));
  } catch (err) {
    fail(`spec/schemas/${name}.json: does not compile — ${err.message}`);
  }
}

// ── 2. validate every fixture ────────────────────────────────────────────
const manifest = readJson(join(fixturesDir, "index.json"));
const listed = new Set();
let checked = 0;

for (const entry of manifest.fixtures) {
  listed.add(entry.file);
  const abs = join(fixturesDir, entry.file);
  try {
    statSync(abs);
  } catch {
    fail(`spec/fixtures/index.json lists ${entry.file}, which does not exist`);
    continue;
  }

  if (entry.expect === "n/a") {
    if (entry.schema) fail(`${entry.file}: expect "n/a" but a schema is declared`);
    continue;
  }
  if (!entry.schema) {
    fail(`${entry.file}: expect "${entry.expect}" requires a schema`);
    continue;
  }

  const validate = validators.get(entry.schema);
  if (!validate) {
    fail(`${entry.file}: unknown schema "${entry.schema}"`);
    continue;
  }

  let doc;
  try {
    doc = readJson(abs);
  } catch (err) {
    fail(`${entry.file}: not parseable as JSON — ${err.message}`);
    continue;
  }

  const ok = validate(doc);
  checked += 1;

  if (entry.expect === "valid" && !ok) {
    const detail = (validate.errors ?? [])
      .slice(0, 6)
      .map((e) => `      ${e.instancePath || "/"} ${e.message}`)
      .join("\n");
    fail(`${entry.file}: expected to satisfy "${entry.schema}" but did not\n${detail}`);
  }
  if (entry.expect === "invalid" && ok) {
    fail(`${entry.file}: expected NOT to satisfy "${entry.schema}" but it did — schema regression`);
  }
}

// ── 3. nothing on disk is unlisted ───────────────────────────────────────
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      walk(abs);
      continue;
    }
    const rel = relative(fixturesDir, abs).split(sep).join("/");
    if (rel === "index.json" || rel === "generate.mjs" || rel.endsWith("README.md")) continue;
    if (!listed.has(rel)) fail(`spec/fixtures/${rel} is not listed in index.json — nothing checks it`);
  }
};
walk(fixturesDir);

// ── report ───────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error("schema:check FAILED\n");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(`\n${failures.length} problem(s).`);
  process.exit(1);
}

console.log(`schema:check ok — ${schemaFiles.length} schemas compiled, ${checked} fixtures validated.`);
