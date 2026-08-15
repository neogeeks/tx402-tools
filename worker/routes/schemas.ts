/**
 * /api/v1/schemas.
 *
 * Serving the frozen schemas over HTTP is what lets the CLI and the MCP
 * server validate against the SAME artifacts the tests use, at the URL
 * their `$id` already claims. A schema whose `$id` 404s is a
 * schema nobody can resolve.
 *
 * Schemas are imported at build time, so this route makes no filesystem or
 * network access at request time.
 */

import { envelope, errorResponse, json } from "../http.js";
import type { RouteContext, RouteHandler } from "../types.js";

import common from "../../spec/schemas/common.json";
import envelopeSchema from "../../spec/schemas/envelope.json";
import errorSchema from "../../spec/schemas/error.json";
import inspect from "../../spec/schemas/inspect.json";
import verify from "../../spec/schemas/verify.json";
import verifyRequest from "../../spec/schemas/verify-request.json";
import policy from "../../spec/schemas/policy.json";
import policyRequest from "../../spec/schemas/policy-request.json";
import history from "../../spec/schemas/history.json";
import compare from "../../spec/schemas/compare.json";
import replay from "../../spec/schemas/replay.json";
import health from "../../spec/schemas/health.json";
import facilitators from "../../spec/schemas/facilitators.json";
import challengeInput from "../../spec/schemas/challenge-input.json";

const SCHEMAS: Record<string, unknown> = {
  common,
  envelope: envelopeSchema,
  error: errorSchema,
  inspect,
  verify,
  "verify-request": verifyRequest,
  policy,
  "policy-request": policyRequest,
  history,
  compare,
  replay,
  health,
  facilitators,
  "challenge-input": challengeInput,
};

export const schemaIndex: RouteHandler = (ctx: RouteContext): Response =>
  json(
    envelope(ctx.route, {
      schemas: Object.keys(SCHEMAS)
        .sort()
        .map((name) => ({ name, url: `/api/v1/schemas/${name}` })),
    }),
    {},
    ctx,
  );

export const schemaOne: RouteHandler = (ctx: RouteContext): Response => {
  const name = ctx.params.name ?? "";
  const schema = SCHEMAS[name];
  if (!schema) return errorResponse("NOT_FOUND", { message: "No such schema." });
  // Schemas are frozen artifacts, so they cache hard.
  return json(schema, {
    headers: { "cache-control": "public, max-age=3600, stale-while-revalidate=86400" },
  });
};
