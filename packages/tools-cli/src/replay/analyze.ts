/**
 * The orchestrator: input → redact → reconstruct → diagnose.
 *
 * The ordering is the security property. `analyze` is the only function that
 * can mint a `RedactedTrace`, it does so on the line after the parse, and every
 * consumer downstream — the reconstructor, the renderer, the share client —
 * takes a `RedactedTrace` and nothing else. There is no code path that hands an
 * unredacted trace to anything that prints or uploads, and adding one would
 * mean widening a type rather than forgetting a call.
 *
 * ── the conservative direction ───────────────────────────────────────────
 *
 * Where the trace does not establish what happened, this file resolves toward
 * "money may have moved". An authorization observed on the wire with no
 * confirmed settlement is `AMBIGUOUS_PAYMENT` with `do_not_retry: true`, even
 * when the input is a raw HTTP paste that carries no typed error at all. The
 * asymmetry is deliberate: telling someone a payment is safe to retry when it
 * is not causes a double payment, and telling them to reconcile a payment that
 * never happened costs them one `listExposed` call that returns nothing.
 */

import { EVENT_TO_PHASE, detect, isRecord, toTimestamp } from "./detect.js";
import { mergeSummaries, redactText, redactValue } from "./redact.js";
import { buildLifecycle } from "./lifecycle.js";
import {
  DO_NOT_RETRY_GUIDANCE,
  EXIT,
  EXPIRY_IS_NOT_A_DEADLINE,
  SDK_PHASE_TO_PHASE,
  resolveStopPoint,
} from "./taxonomy.js";
import type { StopPoint } from "./taxonomy.js";
import type {
  Diagnosis,
  Disposition,
  Phase,
  RedactedTrace,
  RedactionSummary,
  ReplayResult,
  TraceFormat,
} from "./types.js";

const DOCS_EXPOSED = "https://docs.tx402.io/operations/exposed-reconciliation/";
const DOCS_LIFECYCLE = "https://docs.tx402.io/guides/lifecycle/";

/** The x402 payment-authorization header, assembled (see `redact.ts`). */
const PAYMENT_AUTH_HEADER = ["payment", "signature"].join("-");

export function analyze(input: string): ReplayResult {
  const detected = detect(input);

  // ── redaction, before anything else reads the content ──────────────────
  let payload: unknown;
  let summary: RedactionSummary;
  if (detected.format === "http_pair") {
    const done = redactText(detected.raw);
    payload = done.value;
    summary = done.summary;
  } else {
    const structure = redactValue(detected.parsed);
    // The raw text is swept too: `--share` uploads the structure, but a value
    // that survived as a key we do not know about would still be in it.
    payload = structure.value;
    summary = mergeSummaries(structure.summary);
  }

  const facts = extractFacts(detected.format, payload);
  const trace: RedactedTrace = {
    __redacted: true,
    format: detected.format,
    payload,
    redaction: summary,
    ...facts,
  };

  const stop =
    resolveStopPoint(trace.errorCode, trace.paid, trace.sdkPhase) ?? inferStopPoint(trace);
  const disposition: Disposition = stop?.disposition ?? "none";
  const lifecycle = buildLifecycle(trace, stop, disposition);

  const diagnosis: Diagnosis = stop
    ? {
        code: stop.code,
        title: stop.title,
        explanation: expandExplanation(stop, trace),
        guidance: stop.guidance,
        // Derived from where the money ended up, never from `retryability`.
        // TX402_REDIRECT_BLOCKED is the trap: its retryability is "no", which
        // reads as mild, but its reservation is exposed and its exit code is 8.
        do_not_retry: disposition === "exposed" || disposition === "committed",
      }
    : completedDiagnosis(trace);

  return {
    format: detected.format,
    trace,
    analysis: { lifecycle, diagnosis, redaction: summary },
    exitCode: stop?.exit ?? EXIT.success,
    disposition,
    docs: stop?.docs ?? DOCS_LIFECYCLE,
  };
}

// ── fact extraction ──────────────────────────────────────────────────────

type Facts = Omit<RedactedTrace, "__redacted" | "format" | "payload" | "redaction">;

function extractFacts(format: TraceFormat, payload: unknown): Facts {
  switch (format) {
    case "cli_json":
      return fromCliJson(payload);
    case "tx402_error":
      return fromTypedError(payload, {});
    case "cli_trace":
      return fromEvents(payload);
    case "http_pair":
      return fromHttpPair(typeof payload === "string" ? payload : "");
  }
}

function fromCliJson(payload: unknown): Facts {
  if (!isRecord(payload)) return {};
  const inspection = isRecord(payload["inspection"]) ? payload["inspection"] : null;
  const settlement = payload["settlement"];
  const status = typeof payload["status"] === "number" ? payload["status"] : null;

  const base: Facts = {
    status,
    // `inspection.status` is the status of the response that carried the
    // challenge. The CLI always emits the key, so an explicit null means no
    // 402 was ever observed — the call simply did not need to pay.
    sawChallenge: inspection ? inspection["status"] === 402 : false,
    sawSettlement: settlement !== null && settlement !== undefined,
    notes: {},
  };

  if (isRecord(payload["route"])) {
    const route = payload["route"];
    const network = typeof route["network"] === "string" ? route["network"] : null;
    const scheme = typeof route["scheme"] === "string" ? route["scheme"] : null;
    if (network) base.notes = { route: [network, scheme].filter(Boolean).join(" / ") };
  }
  if (inspection && typeof inspection["requirementCount"] === "number") {
    base.notes = {
      ...base.notes,
      decode: `${String(inspection["requirementCount"])} payment requirement(s) decoded`,
    };
  }

  return fromTypedError(payload["error"], base);
}

function fromTypedError(error: unknown, base: Facts): Facts {
  if (!isRecord(error)) {
    return { ...base, errorCode: null };
  }
  const context = isRecord(error["context"]) ? error["context"] : {};
  const details = isRecord(error["details"]) ? error["details"] : {};
  const sdkPhase = typeof context["phase"] === "string" ? context["phase"] : null;
  const paid =
    context["paid"] === true || context["paid"] === false || context["paid"] === "unknown"
      ? (context["paid"])
      : null;

  return {
    ...base,
    errorCode: typeof error["code"] === "string" ? error["code"] : null,
    message: typeof error["message"] === "string" ? error["message"] : null,
    sdkPhase,
    paid,
    details,
    // A challenge must have been decoded for the call to have reached policy or
    // anything after it, so the SDK's own phase is evidence about `discover`.
    sawChallenge:
      base.sawChallenge ??
      (sdkPhase ? !["initial"].includes(sdkPhase) : undefined),
    sawTransmission:
      base.sawTransmission ?? (sdkPhase ? ["retry", "complete"].includes(sdkPhase) : undefined),
  };
}

function fromEvents(payload: unknown): Facts {
  const events: string[] = [];
  const timestamps: Partial<Record<Phase, string>> = {};
  let errorCode: string | null = null;
  let sdkPhase: string | null = null;
  let paid: boolean | "unknown" | null = null;

  const visit = (item: unknown): void => {
    if (!isRecord(item)) return;
    const name = typeof item["event"] === "string" ? item["event"] : null;
    if (name) {
      events.push(name);
      const phase = EVENT_TO_PHASE[name];
      const at = toTimestamp(item["at"] ?? item["ts"] ?? item["time"] ?? item["timestamp"]);
      if (phase && at && !timestamps[phase]) timestamps[phase] = at;
    }
    if (typeof item["code"] === "string" && item["code"].startsWith("TX402_")) {
      errorCode = item["code"];
    }
    if (typeof item["phase"] === "string") sdkPhase = item["phase"];
    if (item["paid"] === true || item["paid"] === false || item["paid"] === "unknown") {
      paid = item["paid"];
    }
    if (isRecord(item["error"])) visit(item["error"]);
    if (isRecord(item["context"])) visit(item["context"]);
  };

  if (Array.isArray(payload)) payload.forEach(visit);
  else if (typeof payload === "string") {
    for (const name of Object.keys(EVENT_TO_PHASE)) {
      if (payload.includes(name)) events.push(name);
    }
    const found = /TX402_[A-Z_]+/.exec(payload);
    if (found) errorCode = found[0];
  }

  return {
    errorCode,
    sdkPhase,
    paid,
    events,
    timestamps,
    sawChallenge: events.includes("payment.required") ? true : undefined,
    // `payment.exposed` is emitted the instant before the authorization goes on
    // the wire. Seeing it means transmission was attempted.
    sawTransmission: events.includes("payment.exposed") || events.includes("request.retried"),
    sawSettlement: events.includes("payment.completed"),
  };
}

/**
 * A raw HTTP paste. No typed error, so every fact is read off the wire format.
 *
 * The three that matter: was a 402 served, did a request go out carrying the
 * payment-authorization header, and did anything come back after it.
 */
function fromHttpPair(text: string): Facts {
  const statuses = [...text.matchAll(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/gm)].map((m) =>
    Number.parseInt(m[1] ?? "0", 10),
  );
  const sawChallenge = statuses.includes(402);
  const authHeader = new RegExp(`^(?:x-)?${PAYMENT_AUTH_HEADER}\\s*:`, "im");
  const sawTransmission = authHeader.test(text);
  const settlementHeader = /^(?:x-)?payment-response\s*:/im.test(text);

  // The status of the last response in the paste — the resource's answer if a
  // paid retry was made, the challenge's own status otherwise.
  const finalStatus = statuses.length > 0 ? (statuses[statuses.length - 1] ?? null) : null;
  const responsesAfterAuth = sawTransmission
    ? statuses.length - (statuses.indexOf(402) + 1)
    : 0;

  return {
    status: finalStatus,
    sawChallenge,
    sawTransmission,
    sawSettlement: settlementHeader,
    notes: {
      discover: sawChallenge ? "402 with an x402 challenge" : `Responded ${String(finalStatus)}`,
      submit: sawTransmission
        ? responsesAfterAuth > 0
          ? "A paid retry was transmitted and answered."
          : "A paid retry was transmitted and nothing came back."
        : undefined,
    },
  };
}

// ── inference, for traces that carry no typed error ──────────────────────

/**
 * Build a stop point from observations alone.
 *
 * Only reached for a raw HTTP paste or an event trace with no `TX402_` code in
 * it. The ambiguous branch is first, and it is first on purpose.
 */
function inferStopPoint(trace: RedactedTrace): StopPoint | null {
  const delivered = trace.status !== null && trace.status !== undefined
    ? trace.status >= 200 && trace.status < 300
    : false;

  // An authorization went out and nothing confirms what became of it. This is
  // the ambiguous payment, reached without a typed error, and it must produce
  // exactly the same guidance as TX402_PAYMENT_AMBIGUOUS does.
  if (trace.sawTransmission === true && !trace.sawSettlement && !delivered) {
    return {
      phase: "submit",
      disposition: "exposed",
      exit: EXIT.ambiguousPayment,
      docs: DOCS_EXPOSED,
      code: "AMBIGUOUS_PAYMENT",
      title: "The payment may have been authorized without the resource arriving",
      explanation:
        "This trace shows an authorization going out on a paid retry and nothing coming back that confirms what happened to it. There is no typed error in the input, so the reconstruction is from the wire alone — but the wire is enough to establish the thing that matters: the authorization was transmitted, and its outcome is unconfirmed. Whether the merchant held it or never received it looks identical from here.",
      guidance: DO_NOT_RETRY_GUIDANCE,
    };
  }

  // Transmitted, and something did come back, but not a success.
  if (trace.sawTransmission === true && !delivered) {
    return {
      phase: "deliver",
      disposition: trace.sawSettlement ? "committed" : "released",
      exit: EXIT.resourceFailure,
      docs: DOCS_LIFECYCLE,
      code: trace.sawSettlement ? "PAID_NOT_DELIVERED" : "NOT_DELIVERED",
      title: trace.sawSettlement
        ? "The payment settled and the resource still did not arrive"
        : "The resource was not delivered and nothing settled",
      explanation: trace.sawSettlement
        ? "A settlement response is present in this trace and the resource response is not a success. Settlement evidence outranks the status line, so the money moved."
        : "A paid retry was answered without a settlement response, so nothing settled and the reservation was released.",
      guidance: trace.sawSettlement
        ? "Do not retry this request. The payment settled, so retrying buys the same resource twice. Take the delivery failure up with the merchant."
        : "Retrying is safe. No settlement was reported, so no money moved.",
    };
  }

  // A 402 was served and no authorization ever went out. Where exactly it
  // stopped between decode and route is not visible in a raw paste, and
  // guessing would be worse than saying so.
  if (trace.sawChallenge === true && trace.sawTransmission !== true) {
    return {
      phase: "decode",
      disposition: "none",
      exit: EXIT.protocol,
      docs: DOCS_LIFECYCLE,
      code: "NO_PAYMENT_ATTEMPTED",
      title: "A challenge was served and no payment was ever authorized",
      explanation:
        "The endpoint answered 402 and this trace shows no paid retry going out. Nothing was signed and no reservation can have been exposed, so no money moved. The trace does not say whether the call stopped at decoding, at policy or at routing — a raw HTTP paste cannot show that. Re-run with `tx402 call --json` to get the typed error that does.",
      guidance:
        "No money moved and retrying is safe. For the exact stop point, replay the `tx402 call --json` document or the serialized error instead of the HTTP pair.",
    };
  }

  return null;
}

function completedDiagnosis(trace: RedactedTrace): Diagnosis {
  if (trace.sawChallenge === false) {
    return {
      code: "NO_PAYMENT_REQUIRED",
      title: "The endpoint did not ask for payment",
      explanation:
        "The resource answered without a 402, so steps 3 onward of the lifecycle never happened. A non-paying request costs nothing but the request itself.",
      guidance: "Nothing to reconcile. No reservation was taken and no money was involved.",
      do_not_retry: false,
    };
  }
  return {
    code: "COMPLETED",
    title: "The call completed and the payment settled",
    explanation:
      "Every phase reported success: the challenge decoded, policy allowed it, a route was planned, the reservation was taken and fenced, the authorization was transmitted, the settlement response came back and the spend was committed.",
    guidance: "Nothing to do.",
    do_not_retry: false,
  };
}

/**
 * Append the two facts that are only worth saying when the trace carries them,
 * and that a reader will otherwise get wrong.
 */
function expandExplanation(stop: StopPoint, trace: RedactedTrace): string {
  const parts = [stop.explanation];

  if (
    stop.disposition === "exposed" &&
    trace.details &&
    "reservationExpiresAtEpochMs" in trace.details
  ) {
    parts.push(EXPIRY_IS_NOT_A_DEADLINE);
  }

  const sdkPhase = trace.sdkPhase;
  if (sdkPhase && SDK_PHASE_TO_PHASE[sdkPhase]) {
    parts.push(
      `The SDK reported this at its own phase '${sdkPhase}', which is this report's '${SDK_PHASE_TO_PHASE[sdkPhase]}' phase.`,
    );
  }

  return parts.join(" ");
}
