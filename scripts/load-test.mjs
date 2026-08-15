#!/usr/bin/env node
/**
 * The load harness behind the numbers in docs/cost-model.md § "What breaks first".
 *
 * It is committed rather than run once and written up, because a bottleneck
 * claimed in a document and a bottleneck anyone can reproduce are different
 * kinds of claim, and only the second one survives a change to the limiter.
 *
 * ── The rule this harness obeys ────────────────────────────────────────────
 *
 * **It never points load at somebody else's endpoint.** That is the exact abuse
 * this product exists to refuse, and committing it in the name of measuring how
 * well we refuse it would be absurd. Every scenario names ONE outbound target,
 * `--target`, which defaults to a URL on this project's own origin. The
 * politeness window means that target receives one request per ten minutes no
 * matter how hard the harness pushes, which is itself the property under test.
 *
 * ── How the collapse is observed without instrumenting the target ──────────
 *
 * `meta.cached` is false only for the caller that actually ran the probe, and
 * true for everyone served the leader's result. So "how many outbound requests
 * did N concurrent callers cause" is answerable from the responses alone:
 * count the `cached: false`. No access to the target is required, which is what
 * makes the collapse checkable against production as well as against dev.
 *
 * Usage:
 *   node scripts/load-test.mjs --base http://127.0.0.1:8787
 *   node scripts/load-test.mjs --base http://127.0.0.1:8787 --scenario collapse
 *   node scripts/load-test.mjs --json > results.json
 */

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/u, ""), process.argv[i + 1] ?? "true");
}

const BASE = args.get("base") ?? "http://127.0.0.1:8787";
const TARGET = args.get("target") ?? "https://tools.tx402.io/api/v1/health";
const SCENARIO = args.get("scenario") ?? "all";
const AS_JSON = args.has("json");

/**
 * The measured baseline this harness multiplies.
 *
 * 145 scans in one hour is the busiest hour the live service has actually seen
 * (`SELECT count(*) FROM scans GROUP BY hour`, 2026-08-15). It is a real number
 * rather than a guess, and it is deliberately the PEAK hour rather than the mean
 * — multiplying a mean by 100 flatters the result.
 */
const BASELINE_SCANS_PER_HOUR = 145;
const MULTIPLIER = Number(args.get("multiplier") ?? 100);

const log = (...parts) => {
  if (!AS_JSON) console.log(...parts);
};

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function summarize(samples) {
  const latencies = samples.map((s) => s.ms).sort((a, b) => a - b);
  const byStatus = {};
  const byCode = {};
  for (const sample of samples) {
    byStatus[sample.status] = (byStatus[sample.status] ?? 0) + 1;
    if (sample.code) byCode[sample.code] = (byCode[sample.code] ?? 0) + 1;
  }
  return {
    requests: samples.length,
    p50_ms: percentile(latencies, 50),
    p95_ms: percentile(latencies, 95),
    p99_ms: percentile(latencies, 99),
    max_ms: latencies[latencies.length - 1] ?? null,
    by_status: byStatus,
    by_error_code: byCode,
    probes: samples.filter((s) => s.cached === false).length,
    cache_hits: samples.filter((s) => s.cached === true).length,
  };
}

/**
 * One request, reduced to the four facts every scenario needs from it.
 *
 * `caller` sets `cf-connecting-ip`, which is what `callerKey` hashes. Without
 * it every request in a run shares one caller key and the per-caller budget (30
 * per 60 seconds) refuses the 31st — so a "200 concurrent callers" scenario run
 * from one machine measures the per-caller budget and nothing else. That is a
 * genuine finding about the system and a useless way to test the collapse, so
 * the scenarios that care about the collapse pass distinct callers and the one
 * that cares about the per-caller budget deliberately does not.
 *
 * On the real edge `cf-connecting-ip` is set by Cloudflare and cannot be spoofed
 * by a client — Cloudflare rejects a request carrying one with a 403 and its
 * error 1000, before the Worker is ever invoked. That was verified against
 * production rather than assumed, and it is the reason the per-caller budget is
 * meaningful there and forgeable here. `SPOOFABLE` therefore turns the header
 * off against any base that is not localhost: sending it would turn every
 * scenario into a uniform wall of 403s that looks like a finding and is not.
 */
const SPOOFABLE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/u.test(BASE);
if (!SPOOFABLE) {
  log(
    `  note: ${BASE} is a real edge, which refuses a client-supplied cf-connecting-ip.\n` +
      `        Distinct callers cannot be simulated, so every request below shares one\n` +
      `        caller key and the per-caller budget (30/60s) is what will answer.`,
  );
}

async function hit(url, caller = null) {
  if (!SPOOFABLE) caller = null;
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        ...(caller === null ? {} : { "cf-connecting-ip": caller }),
      },
    });
    const body = await response.json().catch(() => null);
    return {
      ms: performance.now() - started,
      status: response.status,
      // `cached: false` marks the one caller that actually probed. Counting
      // these IS the outbound request count.
      cached: body?.meta?.cached ?? null,
      code: body?.error?.code ?? null,
    };
  } catch (error) {
    return { ms: performance.now() - started, status: 0, cached: null, code: String(error).slice(0, 60) };
  }
}

const inspectUrl = (target) => `${BASE}/api/v1/inspect?url=${encodeURIComponent(target)}`;

// ── scenario: the collapse, under real concurrency ────────────────────────

/**
 * The claim the whole per-target design rests on, tested against workerd rather
 * than against a resolved promise in a unit test.
 *
 * A unit test's "concurrent" callers are microtasks in one isolate. These are
 * real HTTP requests that may land on different isolates and reach the Durable
 * Object over the network, which is the only place the single-flight lease can
 * actually fail.
 */
async function collapse(concurrency = 200) {
  log(`\n── collapse: ${concurrency} concurrent DISTINCT callers, one target ──`);
  // A fresh target each run, or the previous run's cache answers everything and
  // the collapse is never exercised.
  const target = `${TARGET}?collapse=${Date.now()}`;
  const samples = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => hit(inspectUrl(target), `198.51.100.${i % 254}`)),
  );
  const summary = summarize(samples);
  log(`  outbound probes: ${summary.probes}  (cache hits: ${summary.cache_hits})`);
  log(`  p50 ${summary.p50_ms?.toFixed(0)}ms · p95 ${summary.p95_ms?.toFixed(0)}ms · p99 ${summary.p99_ms?.toFixed(0)}ms`);
  log(`  statuses: ${JSON.stringify(summary.by_status)}`);
  return { scenario: "collapse", concurrency, ...summary };
}

/**
 * The same shape from ONE caller, which is the abuse case rather than the
 * popularity case. The per-caller budget is what should answer here, and the
 * number of outbound probes must still be at most one.
 */
async function singleCallerFlood(concurrency = 200) {
  log(`\n── single-caller flood: ${concurrency} concurrent from ONE caller, one target ──`);
  const target = `${TARGET}?flood=${Date.now()}`;
  const samples = await Promise.all(
    Array.from({ length: concurrency }, () => hit(inspectUrl(target), "203.0.113.99")),
  );
  const summary = summarize(samples);
  log(`  outbound probes: ${summary.probes}  refused: ${summary.by_status[429] ?? 0}`);
  log(`  p50 ${summary.p50_ms?.toFixed(0)}ms · p99 ${summary.p99_ms?.toFixed(0)}ms · codes ${JSON.stringify(summary.by_error_code)}`);
  return { scenario: "single_caller_flood", concurrency, ...summary };
}

// ── scenario: 100× current traffic, sustained ─────────────────────────────

/**
 * Distinct targets, so nothing collapses and every request is the expensive
 * path: a fresh Durable Object, an admission against the daily ceiling, a probe
 * and a D1 write batch. This is the shape of the load that costs money.
 *
 * The URLs differ only by a query parameter, so they canonicalize to different
 * endpoint ids while still naming ONE host — ours.
 */
async function sustained(seconds = 60) {
  const perHour = BASELINE_SCANS_PER_HOUR * MULTIPLIER;
  const rps = perHour / 3600;
  log(`\n── sustained: ${MULTIPLIER}× the busiest measured hour (${perHour}/h = ${rps.toFixed(2)} rps) for ${seconds}s ──`);

  const samples = [];
  const started = Date.now();
  let issued = 0;
  const inFlight = new Set();

  while (Date.now() - started < seconds * 1000) {
    const due = Math.floor(((Date.now() - started) / 1000) * rps) - issued;
    for (let i = 0; i < due; i += 1) {
      issued += 1;
      const promise = hit(inspectUrl(`${TARGET}?n=${issued}`), `198.51.100.${issued % 254}`).then((sample) => {
        samples.push(sample);
        inFlight.delete(promise);
      });
      inFlight.add(promise);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await Promise.all([...inFlight]);

  const summary = summarize(samples);
  log(`  ${summary.requests} requests · p50 ${summary.p50_ms?.toFixed(0)}ms · p95 ${summary.p95_ms?.toFixed(0)}ms · p99 ${summary.p99_ms?.toFixed(0)}ms`);
  log(`  statuses: ${JSON.stringify(summary.by_status)}  codes: ${JSON.stringify(summary.by_error_code)}`);
  return { scenario: "sustained", multiplier: MULTIPLIER, target_rps: rps, ...summary };
}

// ── scenario: saturate, to find what actually gives ───────────────────────

/**
 * Ramp concurrency until latency or errors move. "It served 100×" is not the
 * interesting answer; the interesting answer is the first thing to bend, and a
 * test that stops at the target rate cannot find it.
 *
 * Every step uses distinct targets, so each one goes through the global
 * `/admit` object — the single serialization point this design added, and
 * therefore the most likely bottleneck in the whole system.
 */
async function saturate(steps = [10, 25, 50, 100, 200, 400]) {
  log(`\n── saturation ramp: distinct targets, every request through the global ceiling ──`);
  const results = [];
  let issued = 0;

  for (const concurrency of steps) {
    const started = performance.now();
    const samples = await Promise.all(
      Array.from({ length: concurrency }, () => {
        issued += 1;
        return hit(inspectUrl(`${TARGET}?ramp=${issued}`), `198.51.100.${issued % 254}`);
      }),
    );
    const wall = performance.now() - started;
    const summary = summarize(samples);
    const throughput = (concurrency / wall) * 1000;
    log(
      `  ${String(concurrency).padStart(4)} concurrent → ${throughput.toFixed(1)} rps · ` +
        `p50 ${summary.p50_ms?.toFixed(0)}ms · p99 ${summary.p99_ms?.toFixed(0)}ms · ` +
        `${JSON.stringify(summary.by_status)}`,
    );
    results.push({ concurrency, throughput_rps: throughput, wall_ms: wall, ...summary });
  }
  return { scenario: "saturate", steps: results };
}

// ── scenario: the paths, isolated, so "slow" can be attributed ────────────

/**
 * Three ramps that differ only in how much of the path they run, so the
 * saturation point can be attributed to a component instead of guessed at.
 *
 *   refusal  router + guard only. A private literal is refused before DNS, the
 *            Durable Object or any probe, so this is the floor: whatever the
 *            runtime and the router cost, and nothing else.
 *   health   D1 + Analytics Engine + the ONE global ceiling object. Every
 *            request in this ramp serializes through the same object, so if a
 *            single Durable Object were the system's ceiling it would show here.
 *   probe    the full path, from `saturate`.
 *
 * The difference between the first two and the third is the bill.
 */
async function attribute(concurrency = 200) {
  log(`\n── attribution: the same concurrency (${concurrency}) against three depths ──`);
  const depths = [
    {
      name: "refusal (router + guard, no DNS, no DO, no probe)",
      url: () => inspectUrl("https://10.0.0.5/v1"),
    },
    {
      name: "health (D1 + AE + the one global ceiling object)",
      url: () => `${BASE}/api/v1/health`,
    },
  ];

  const results = [];
  for (const depth of depths) {
    const started = performance.now();
    const samples = await Promise.all(
      Array.from({ length: concurrency }, (_, i) => hit(depth.url(), `198.51.100.${i % 254}`)),
    );
    const wall = performance.now() - started;
    const summary = summarize(samples);
    const rps = (concurrency / wall) * 1000;
    log(`  ${rps.toFixed(0).padStart(5)} rps · p50 ${summary.p50_ms?.toFixed(0)}ms · ${depth.name}`);
    results.push({ depth: depth.name, throughput_rps: rps, ...summary });
  }
  return { scenario: "attribute", concurrency, depths: results };
}

// ── scenario: the global ceiling in isolation ─────────────────────────────

/**
 * `/api/v1/health` reads the daily budget from the one global Durable Object and
 * touches nothing else expensive. Hammering it measures that object's ceiling
 * on its own, separated from probing, D1 and the guard — so a slow result here
 * and a slow result in `saturate` mean different things.
 */
async function globalObject(concurrency = 200) {
  log(`\n── the global ceiling object alone: ${concurrency} concurrent reads ──`);
  const started = performance.now();
  const samples = await Promise.all(
    Array.from({ length: concurrency }, () => hit(`${BASE}/api/v1/health`)),
  );
  const wall = performance.now() - started;
  const summary = summarize(samples);
  log(
    `  ${((concurrency / wall) * 1000).toFixed(1)} rps · p50 ${summary.p50_ms?.toFixed(0)}ms · ` +
      `p99 ${summary.p99_ms?.toFixed(0)}ms · ${JSON.stringify(summary.by_status)}`,
  );
  return { scenario: "global_object", concurrency, throughput_rps: (concurrency / wall) * 1000, ...summary };
}

// ── run ───────────────────────────────────────────────────────────────────

const run = {
  base: BASE,
  target: TARGET,
  baseline_scans_per_hour: BASELINE_SCANS_PER_HOUR,
  multiplier: MULTIPLIER,
  scenarios: [],
};

if (SCENARIO === "all" || SCENARIO === "global") run.scenarios.push(await globalObject());
if (SCENARIO === "all" || SCENARIO === "collapse") run.scenarios.push(await collapse());
if (SCENARIO === "all" || SCENARIO === "flood") run.scenarios.push(await singleCallerFlood());
if (SCENARIO === "all" || SCENARIO === "sustained") run.scenarios.push(await sustained(30));
if (SCENARIO === "all" || SCENARIO === "saturate") run.scenarios.push(await saturate());
if (SCENARIO === "all" || SCENARIO === "attribute") run.scenarios.push(await attribute());

if (AS_JSON) console.log(JSON.stringify(run, null, 2));
