/**
 * The published facilitator list.
 *
 * "✓ known facilitator" is a trust claim, and allows exactly one
 * reading of it: *it is on this list, and this list is public*. So every row
 * carries `source_url` and `source_dated`, and the list is a D1 table rather
 * than a hardcoded array, because new facilitators appear (O4).
 *
 * The list itself, its provenance, and the `listed`/`unverified` distinction
 * live in `worker/lib/facilitators.ts`. This file only renders it.
 */

import { envelope, json } from "../http.js";
import {
  FACILITATOR_LIST_VERSION,
  loadFacilitators,
  type FacilitatorRow,
} from "../lib/facilitators.js";
import type { RouteContext, RouteHandler, Warning } from "../types.js";

function toWire(row: FacilitatorRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    discovery_url: row.discovery_url,
    operator: row.operator,
    networks: row.networks,
    status: row.status,
    source_url: row.source_url,
    source_dated: row.source_dated,
    notes: row.notes,
  };
}

export const facilitators: RouteHandler = async (ctx: RouteContext): Promise<Response> => {
  const { rows, source } = await loadFacilitators(ctx.env);

  const warnings: Warning[] = [];
  if (source === "bundled") {
    // Said out loud rather than hidden: a reader checking a "known facilitator"
    // claim is entitled to know the list came from the deployed build rather
    // than from the table the crawler maintains.
    warnings.push({
      code: "BUNDLED_LIST",
      message:
        "Serving the list bundled with this deployment; the facilitators table has not been seeded.",
    });
  }

  return json(
    envelope(
      ctx.route,
      {
        list_version: FACILITATOR_LIST_VERSION,
        facilitators: rows.map(toWire),
      },
      { warnings },
    ),
    {},
    ctx,
  );
};
