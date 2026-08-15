/**
 * Frozen-schema validation, at runtime, before anything reaches a model.
 *
 * makes `spec/schemas/` the contract every surface validates
 * against, and every other surface does that **in tests**. This one does it in
 * production too, and the difference is the point: a malformed answer rendered
 * on a web page is a rendering bug that a person sees and shrugs at, whereas a
 * malformed answer handed to an agent is something the agent may act on and
 * pay. So a response that does not validate is an error this server reports —
 * "we could not get a usable answer" — and never a payload it forwards.
 *
 * Same ajv setup as `test/helpers.ts` (`strict: true`, `allErrors: true`, plus
 * `ajv-formats`), and the same schema files, imported rather than read off disk
 * so that the compiled package carries them.
 */

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import commonSchema from "../../../spec/schemas/common.json" with { type: "json" };
import envelopeSchema from "../../../spec/schemas/envelope.json" with { type: "json" };
import errorSchema from "../../../spec/schemas/error.json" with { type: "json" };
import inspectSchema from "../../../spec/schemas/inspect.json" with { type: "json" };
import verifySchema from "../../../spec/schemas/verify.json" with { type: "json" };

const SCHEMAS: readonly object[] = [
  commonSchema,
  envelopeSchema,
  errorSchema,
  inspectSchema,
  verifySchema,
];

const SCHEMA_BASE = "https://tools.tx402.io/api/v1/schemas/";

/**
 * `verify.json` describes a whole hosted envelope, and `verify_challenge`
 * produces only the `data` half — it has no route, so it has no `meta.owner_session`
 * and no `generated_at` that would mean anything. This alias lets the locally
 * computed result be held to the frozen `data` shape without inventing envelope
 * fields to satisfy a validator.
 *
 * The `urn:` id is deliberately outside `tools.tx402.io/api/v1/schemas/`: it is
 * a private alias registered in this package's ajv instance, not a contract
 * file, and nothing in `spec/schemas/` changes to accommodate it. It adds no
 * constraint of its own — it is one `$ref` and nothing else, so it cannot drift
 * from the frozen schema it points at.
 */
export const VERIFY_DATA_SCHEMA_ID = "urn:tx402-tools-mcp:verify-data";

const VERIFY_DATA_ALIAS = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: VERIFY_DATA_SCHEMA_ID,
  $ref: "https://tools.tx402.io/api/v1/schemas/verify#/allOf/1/properties/data",
};

function build(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  addFormats(ajv);
  for (const schema of SCHEMAS) {
    ajv.addSchema(schema, (schema as { $id: string }).$id);
  }
  ajv.addSchema(VERIFY_DATA_ALIAS, VERIFY_DATA_SCHEMA_ID);
  return ajv;
}

let cached: Ajv2020 | null = null;

function ajv(): Ajv2020 {
  cached ??= build();
  return cached;
}

export interface ValidationResult {
  ok: boolean;
  /** Empty when `ok`. One line per failure, joined — safe to show a caller. */
  errors: string;
}

/**
 * Validate a decoded response body against a frozen schema by name, or against
 * a full schema id when one is given (`urn:…`).
 *
 * An unknown schema name is reported as a validation failure rather than
 * thrown, so the one call site has exactly one failure mode to handle and
 * cannot accidentally treat "we have no validator" as "it validated".
 */
export function validateAgainst(name: string, value: unknown): ValidationResult {
  const id = name.includes(":") ? name : `${SCHEMA_BASE}${name}`;
  const validate = ajv().getSchema(id);
  if (!validate) return { ok: false, errors: `no frozen schema named "${name}"` };

  const ok = validate(value);
  if (ok) return { ok: true, errors: "" };

  const errors = (validate.errors ?? [])
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}`)
    .join("; ");
  return { ok: false, errors: errors || "did not match the schema" };
}

/** The schema ids this server can validate against. Exported for the tests. */
export const VALIDATED_SCHEMAS: readonly string[] = Object.freeze(
  SCHEMAS.map((s) => (s as { $id: string }).$id.slice(SCHEMA_BASE.length)),
);
