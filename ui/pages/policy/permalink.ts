/**
 * The permalink.
 *
 * item 4: "the config encoded in the URL. No storage, no
 * account." So the whole request round-trips through readable query
 * parameters, which has three consequences worth stating:
 *
 *  - the form is a plain `method="GET"` form, so **submitting it produces the
 *    permalink**. There is no "share" button to forget to press and no
 *    client-side URL construction to drift from the server's parser.
 *  - a shared link is legible. `?max_per_hour=5.00+USDC` tells you what you are
 *    about to open; an opaque base64 blob does not, and a policy playground
 *    whose links cannot be read in review is a worse teaching tool.
 *  - it works with JavaScript off, which is the same reason the page renders
 *    server-side at all.
 *
 * `preset` is the base and every other parameter overrides it, so
 * `?preset=fleet&max_per_hour=9.00+USDC` is a one-field diff against a known
 * starting point rather than a full config.
 */

import { DEFAULT_PRESET, findPreset } from "./presets.js";
import type {
  ChallengeInput,
  PlaygroundPolicy,
  PlaygroundRecipientPolicy,
  PlaygroundRouting,
  PolicyRequest,
  RecipientAllowEntry,
} from "./types.js";

/** Every parameter the playground reads. Anything else in the URL is ignored. */
export const PARAMS = [
  "preset",
  "max_per_request",
  "max_per_hour",
  "max_total",
  "domains",
  "networks",
  "attempts",
  "recipient_mode",
  "pin",
  "prefer",
  "quote_age_ms",
  "challenge",
  "header",
  "url",
  "method",
  "spent_window",
  "spent_total",
] as const;

function list(value: string | null): string[] | undefined {
  if (value === null) return undefined;
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : [];
}

function text(value: string | null): string | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function integer(value: string | null): number | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * `host|network|recipient[,recipient][;host|network|…]`.
 *
 * A compact form rather than JSON because this is the one field a person is
 * likely to edit in the address bar, and because a JSON blob in a query string
 * is where percent-encoding stops being readable.
 */
function parsePins(value: string | null): RecipientAllowEntry[] | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  const entries = raw
    .split(";")
    .map((group) => group.trim())
    .filter((group) => group.length > 0)
    .map((group) => {
      const [host = "", network = "", recipients = ""] = group.split("|");
      return {
        host: host.trim(),
        network: network.trim(),
        recipients: recipients
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r.length > 0),
      };
    });
  return entries.length > 0 ? entries : undefined;
}

function formatPins(allow: readonly RecipientAllowEntry[]): string {
  return allow.map((entry) => `${entry.host}|${entry.network}|${entry.recipients.join(",")}`).join(";");
}

/**
 * Read a request out of a URL.
 *
 * Never throws. A field the SDK would refuse is passed through verbatim so the
 * SDK is the thing that refuses it — a playground that pre-validates is a
 * playground that can disagree with the engine it is demonstrating.
 */
export function requestFromUrl(url: URL): { request: PolicyRequest; presetId: string | null } {
  const q = url.searchParams;
  const presetId = text(q.get("preset")) ?? null;
  const hasAnyField = PARAMS.some((p) => p !== "preset" && q.get(p) !== null);

  const base = findPreset(presetId) ?? (hasAnyField ? undefined : findPreset(DEFAULT_PRESET));
  const seed: PolicyRequest = base
    ? (JSON.parse(JSON.stringify(base.request)) as PolicyRequest)
    : { policy: {}, challenge: {} };

  const policy: PlaygroundPolicy = { ...seed.policy };

  const maxPerRequest = text(q.get("max_per_request"));
  if (maxPerRequest !== undefined) policy.maxPerRequest = maxPerRequest;
  const maxPerHour = text(q.get("max_per_hour"));
  if (maxPerHour !== undefined) policy.maxPerHour = maxPerHour;
  if (q.get("max_total") !== null) {
    const maxTotal = text(q.get("max_total"));
    if (maxTotal === undefined) delete policy.maxTotal;
    else policy.maxTotal = maxTotal;
  }
  const domains = list(q.get("domains"));
  if (domains !== undefined) policy.allowedDomains = domains;
  const networks = list(q.get("networks"));
  if (networks !== undefined) policy.allowedNetworks = networks;
  const attempts = integer(q.get("attempts"));
  if (attempts !== undefined) policy.maxPaidAttempts = attempts;

  const mode = text(q.get("recipient_mode"));
  const pins = parsePins(q.get("pin"));
  if (mode !== undefined || pins !== undefined) {
    const recipientPolicy: PlaygroundRecipientPolicy = { ...policy.recipientPolicy };
    if (mode !== undefined) recipientPolicy.mode = mode as PlaygroundRecipientPolicy["mode"];
    // An explicitly empty `pin` clears the allowlist rather than falling back to
    // the preset's, so a shared link that turns pinning off actually does.
    if (q.get("pin") !== null) {
      if (pins === undefined) delete recipientPolicy.allow;
      else recipientPolicy.allow = pins;
    }
    policy.recipientPolicy = recipientPolicy;
  }

  const prefer = list(q.get("prefer"));
  const quoteAge = integer(q.get("quote_age_ms"));
  if (prefer !== undefined || quoteAge !== undefined) {
    const routing: PlaygroundRouting = { ...policy.routing };
    if (prefer !== undefined) routing.preferNetworks = prefer;
    if (quoteAge !== undefined) routing.maxQuoteAgeMs = quoteAge;
    policy.routing = routing;
  }

  // `{mode:"off"}` with nothing pinned is the same policy as no recipient
  // config at all, and the form's select always submits a value. Normalizing
  // here is what makes a form submission and a hand-written permalink parse to
  // the same object, so the round trip is exact rather than merely equivalent.
  if (
    policy.recipientPolicy !== undefined &&
    (policy.recipientPolicy.mode ?? "off") === "off" &&
    !policy.recipientPolicy.allow?.length
  ) {
    delete policy.recipientPolicy;
  }

  let challenge: ChallengeInput = seed.challenge;
  const header = text(q.get("header"));
  const challengeText = text(q.get("challenge"));
  if (header !== undefined) {
    challenge = { header };
  } else if (challengeText !== undefined) {
    challenge = parseChallengeText(challengeText);
  }

  const request: PolicyRequest = { policy, challenge };

  const requestUrl = text(q.get("url")) ?? seed.request?.url ?? undefined;
  const method = text(q.get("method")) ?? seed.request?.method ?? undefined;
  if (requestUrl !== undefined || method !== undefined) {
    request.request = {
      ...(requestUrl === undefined ? {} : { url: requestUrl }),
      ...(method === undefined ? {} : { method }),
    };
  }

  const spentWindow = text(q.get("spent_window")) ?? seed.state?.spent_in_window_atomic ?? undefined;
  const spentTotal = text(q.get("spent_total")) ?? seed.state?.spent_total_atomic ?? undefined;
  if (spentWindow !== undefined || spentTotal !== undefined) {
    request.state = {
      spent_in_window_atomic: spentWindow ?? "0",
      spent_total_atomic: spentTotal ?? "0",
    };
  }

  return { request, presetId: base ? (presetId ?? DEFAULT_PRESET) : null };
}

/**
 * A pasted challenge, as a person actually pastes one: the decoded JSON most of
 * the time, a base64 header when they copied it out of a response.
 *
 * Nothing here validates. `decodePaymentRequired` is the only decoder in this
 * tool, so an input that is neither of those is handed to it as a
 * header and refused with the SDK's own error.
 */
export function parseChallengeText(value: string): ChallengeInput {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    try {
      return { body: JSON.parse(trimmed) as Record<string, unknown> };
    } catch {
      return { body: trimmed };
    }
  }
  return { header: trimmed };
}

/** The textarea value for a challenge input — the JSON when we have it. */
export function challengeToText(challenge: ChallengeInput): string {
  if (typeof challenge.body === "string") return challenge.body;
  if (challenge.body && typeof challenge.body === "object") {
    return JSON.stringify(challenge.body, null, 2);
  }
  return challenge.header ?? challenge.raw ?? "";
}

/**
 * Build the permalink for a request. Round-trips through `requestFromUrl`.
 *
 * `preset` is deliberately **not** written back: the URL carries the whole
 * config, so a link keeps working after a preset's definition changes, and a
 * reader can see what they are opening without resolving a name.
 */
export function urlFromRequest(request: PolicyRequest, base = "/policy"): string {
  const q = new URLSearchParams();
  const p = request.policy;

  // Only what is actually set. A permalink never carries `preset`, so parsing
  // one starts from an empty policy and there is nothing an empty parameter
  // would need to clear — while the form, which always submits every field,
  // still clears by sending the key with an empty value.
  if (p.maxPerRequest !== undefined) q.set("max_per_request", p.maxPerRequest);
  if (p.maxPerHour !== undefined) q.set("max_per_hour", p.maxPerHour);
  if (p.maxTotal !== undefined) q.set("max_total", p.maxTotal);
  if (p.allowedDomains !== undefined) q.set("domains", p.allowedDomains.join(","));
  if (p.allowedNetworks !== undefined) q.set("networks", p.allowedNetworks.join(","));
  if (p.maxPaidAttempts !== undefined) q.set("attempts", String(p.maxPaidAttempts));

  if (p.recipientPolicy?.mode !== undefined) q.set("recipient_mode", p.recipientPolicy.mode);
  if (p.recipientPolicy?.allow?.length) q.set("pin", formatPins(p.recipientPolicy.allow));
  if (p.routing?.preferNetworks?.length) q.set("prefer", p.routing.preferNetworks.join(","));
  if (p.routing?.maxQuoteAgeMs !== undefined) q.set("quote_age_ms", String(p.routing.maxQuoteAgeMs));

  if (request.challenge.header) q.set("header", request.challenge.header);
  else q.set("challenge", challengeToText(request.challenge));

  if (request.request?.url) q.set("url", request.request.url);
  if (request.request?.method) q.set("method", request.request.method);
  q.set("spent_window", request.state?.spent_in_window_atomic ?? "0");
  q.set("spent_total", request.state?.spent_total_atomic ?? "0");

  return `${base}?${q.toString()}`;
}
