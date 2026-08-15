/**
 * The CLI's envelope.
 *
 * SPEC §2 freezes one envelope for every tool, and `spec/schemas/<tool>.json`
 * validates the **whole** envelope rather than just `data`. So `--json` emits
 * an envelope, not a bare payload: `tx402-tools inspect --json` and
 * `curl -H 'Accept: application/json' …/api/v1/inspect` produce documents that
 * validate against the same frozen schema and can be diffed against each other.
 * That equivalence is the point of L5 and it is asserted in `test/cli.test.ts`.
 *
 * `meta.owner_session` names the session that owns the *tool*, not the surface
 * that rendered it, which is why a locally-produced inspect envelope still says
 * ``. Two documents describing the same computation should not disagree about
 * who owns the computation.
 */

import { PACKAGE_VERSION } from "tx402";

/** SPEC §1.3: RFC 3339, UTC, `Z`, second precision. */
export function nowIso(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

export interface Warning {
  code: string;
  message: string;
}

export interface EnvelopeMeta {
  implemented: boolean;
  cached: boolean;
  cache_age_seconds: number | null;
  score_version: string | null;
  tx402_version: string | null;
  schema: string | null;
}

export interface Envelope<T> {
  api_version: "v1";
  tool: string;
  generated_at: string;
  meta: EnvelopeMeta;
  warnings: Warning[];
  data: T;
}

export interface EnvelopeOptions {
  scoreVersion?: string | null;
  origin?: string;
}

export function envelope<T>(
  tool: string,
  data: T,
  warnings: Warning[] = [],
  options: EnvelopeOptions = {},
): Envelope<T> {
  const origin = options.origin ?? "https://tools.tx402.io";
  return {
    api_version: "v1",
    tool,
    generated_at: nowIso(),
    meta: {
      // Nothing the CLI emits is a stub: it either computed the answer or it
      // is relaying one the hosted API computed.
      implemented: true,
      // A local probe is never served from a cache. When the CLI relays a
      // hosted envelope it relays that envelope's `meta` verbatim instead of
      // building one here, so a cached hosted answer keeps saying so.
      cached: false,
      cache_age_seconds: null,
      score_version: options.scoreVersion ?? null,
      tx402_version: PACKAGE_VERSION,
      schema: `${origin}/api/v1/schemas/${tool}`,
    },
    warnings,
    data,
  };
}
