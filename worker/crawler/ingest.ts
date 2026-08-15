/**
 * Turning discovered resources into corpus rows.
 *
 * Every discovery source — Bazaar, awesome-x402, the ecosystem page, and the
 * URLs humans paste into the Inspector — funnels through here, because dedupe
 * is only correct if every source is normalized the same way.
 *
 * **The join key is `canonicalizeUrl` + `endpointId` from `worker/lib/guard.ts`,
 * and nothing else.** Those are the frozen SPEC §1.5 implementations and they
 * are what every table in D1 keys on. Re-deriving "the same URL" here with a
 * lowercase and a trailing-slash strip would produce an id that agrees with the
 * guard most of the time, which is worse than one that never does: the corpus
 * would silently split one endpoint into two rows whose histories each look
 * half as long as the truth.
 *
 * A resource that the guard refuses (a private address, a non-https scheme, a
 * URL with userinfo) is dropped at ingestion rather than stored and skipped at
 * probe time. There is no value in a corpus row we may never probe, and storing
 * one would put an unreachable-by-policy URL on a public listing.
 */

import { validateUrl } from "../lib/guard.js";
import { endpointId } from "../lib/guard.js";
import type { Env } from "../types.js";
import { provenanceStatement, upsertEndpoint, type ProvenanceRow } from "./store.js";
import type { DiscoveredResource, ProbeTier } from "./types.js";

export interface IngestSource {
  source: ProvenanceRow["source"];
  /** The document we read, for provenance. */
  sourceUrl: string | null;
  facilitatorId: string | null;
  /** Endpoints from a directory start cold; a human paste starts warm. */
  tier: ProbeTier;
}

export interface IngestResult {
  seen: number;
  added: number;
  updated: number;
  /** Refused by the URL guard — recorded so a source of junk is visible. */
  rejected: number;
  /** Duplicates WITHIN this batch, collapsed before touching D1. */
  deduped: number;
}

/**
 * `endpoints.discovery_source` has a narrower vocabulary than provenance does.
 *
 * The CHECK constraint in 0001_init.sql allows `bazaar`, `awesome-x402`,
 * `human`, `crawler`, `seed` and `claim` — but not `ecosystem`, which the
 * provenance table does allow. Mapping here rather than widening the constraint
 * keeps a landed migration unedited.
 */
function discoverySourceFor(source: ProvenanceRow["source"]): string {
  return source === "ecosystem" ? "seed" : source;
}

/**
 * Ingest a batch of discovered resources.
 *
 * Dedupe happens twice and both are needed: within the batch (a facilitator can
 * list the same resource under two entries) and against D1 (the same endpoint
 * discovered by a second facilitator last week). The first is a Map; the second
 * is `upsertEndpoint`'s insert-or-touch, which never moves `first_seen`.
 */
export async function ingestResources(
  env: Pick<Env, "DB">,
  resources: DiscoveredResource[],
  source: IngestSource,
  now: string,
): Promise<IngestResult> {
  const result: IngestResult = {
    seen: resources.length,
    added: 0,
    updated: 0,
    rejected: 0,
    deduped: 0,
  };

  // Collapse within the batch first, keyed by the canonical URL so two spellings
  // of one endpoint become one row rather than two.
  const unique = new Map<string, { resource: DiscoveredResource; canonical: string; url: URL }>();

  for (const resource of resources) {
    const validated = validateUrl(resource.url);
    if (!validated.ok) {
      result.rejected += 1;
      continue;
    }

    const canonical = validated.value.canonical;
    if (unique.has(canonical)) {
      result.deduped += 1;
      continue;
    }
    unique.set(canonical, { resource, canonical, url: validated.value.url });
  }

  for (const { resource, canonical, url } of unique.values()) {
    const id = await endpointId(canonical);

    const { added } = await upsertEndpoint(
      env.DB,
      {
        id,
        canonical_url: canonical,
        url: resource.url,
        origin: url.origin,
        host: url.hostname.toLowerCase(),
        path: url.pathname,
        title: resource.serviceName,
        description: resource.description,
        resource_type: resource.type,
        discovery_source: discoverySourceFor(source.source) as
          | "bazaar"
          | "awesome-x402"
          | "human"
          | "crawler"
          | "seed"
          | "claim",
        tier: source.tier,
        // Due immediately: a newly discovered endpoint has no terms at all, and
        // the first probe is what makes it visible to every other tool.
        next_probe_at: now,
      },
      now,
    );

    if (added) result.added += 1;
    else result.updated += 1;

    // Provenance, including the source's own `lastUpdated` claim — recorded
    // as a claim, never as `first_seen`.
    await env.DB.batch([
      provenanceStatement(
        env.DB,
        {
          endpoint_id: id,
          source: source.source,
          source_url: source.sourceUrl,
          facilitator_id: source.facilitatorId,
          claimed_last_updated: resource.claimedLastUpdated,
          observed_at: now,
          first_observed_at: now,
          raw_json: JSON.stringify(resource.raw).slice(0, 8192),
        },
        now,
      ),
    ]);
  }

  return result;
}
