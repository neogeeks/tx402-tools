/**
 * Network stubs for the guard and probe tests.
 *
 * `spec/fixtures/hostile/urls.json` says it plainly: rows whose host is a name
 * rather than a literal are only meaningful when resolution is exercised, so
 * they must be driven "through a stubbed resolver, not a string check". These
 * stubs are what make that true — the guard's own resolver and connector ports
 * are replaced, so the tests exercise the real decision logic against fabricated
 * DNS answers and fabricated hostile responses, and never touch the network.
 */

import type { Connector, Resolver } from "../worker/lib/guard.js";

export const PUBLIC_V4 = "203.0.113.10";
/** A genuinely routable address, since 203.0.113.0/24 is documentation space. */
export const ROUTABLE_V4 = "93.184.216.34";

export interface ScriptedResolver extends Resolver {
  /** How many times each hostname was looked up — the rebind test asserts on it. */
  readonly lookups: Map<string, number>;
}

/**
 * A resolver driven by a table. A value may be a fixed list of addresses or a
 * function of the lookup count, which is the only way to express "public first,
 * private on the second lookup" — the DNS-rebinding case.
 */
export function scriptedResolver(
  table: Record<string, string[] | ((call: number) => string[])>,
): ScriptedResolver {
  const lookups = new Map<string, number>();

  return {
    lookups,
    resolve(hostname: string): Promise<string[]> {
      const host = hostname.toLowerCase().replace(/\.$/u, "");
      const call = (lookups.get(host) ?? 0) + 1;
      lookups.set(host, call);

      const entry = table[host];
      if (!entry) return Promise.reject(new Error(`NXDOMAIN ${host}`));
      return Promise.resolve(typeof entry === "function" ? entry(call) : entry);
    },
  };
}

/** The default resolver for the hostile table: every fixture host, as declared. */
export function hostileResolver(): ScriptedResolver {
  return scriptedResolver({
    "api.example.com": [ROUTABLE_V4],
    "marketplace.example.com": [ROUTABLE_V4],
    "payments.attacker.example": [ROUTABLE_V4],
    "redirector.example.net": [ROUTABLE_V4],
    "slowloris.example.net": [ROUTABLE_V4],
    "public.example.net": [ROUTABLE_V4],

    // Resolves into loopback — rejected for where it goes, not what it is called.
    localhost: ["127.0.0.1"],
    // The GCP metadata name. Rejected because it resolves into link-local space.
    "metadata.google.internal": ["169.254.169.254"],

    // The rebind: a public answer first, loopback on every lookup after it.
    // The guard resolves twice per hop, so the second answer is what it sees.
    "rebind.example.net": (call) => (call === 1 ? [ROUTABLE_V4] : ["127.0.0.1"]),

    // A split RRset: one public record and one private one. The guard must
    // refuse rather than pick the good one, because it does not choose which
    // record the platform's own connect will use.
    "split.example.net": [ROUTABLE_V4, "10.0.0.5"],
  });
}

export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Emit a body that never ends, to exercise the total-time budget. */
  trickle?: boolean;
  /** Emit this many bytes, to exercise the body cap. */
  bytes?: number;
  /** Emit this many junk response headers, to exercise the header caps. */
  headerFlood?: number;
}

export interface ScriptedConnector extends Connector {
  /** Every URL actually requested, in order. The collapse test counts these. */
  readonly requests: string[];
  /** Every pinned address the guard intended to reach. */
  readonly pins: string[];
}

/**
 * A connector driven by a path table. Keys are matched as `host+pathname`, so a
 * single stub can serve a redirect chain and a hostile body from one host.
 */
export function scriptedConnector(
  routes: Record<string, ScriptedResponse>,
): ScriptedConnector {
  const requests: string[] = [];
  const pins: string[] = [];

  return {
    requests,
    pins,
    async fetch(url, init, pin) {
      requests.push(url.toString());
      pins.push(pin.address.text);

      const key = `${url.hostname}${url.pathname}`;
      const route = routes[key] ?? routes[url.hostname] ?? { status: 404 };

      const headers = new Headers(route.headers ?? {});
      if (route.headerFlood) {
        // Distinct names on purpose: `append` with one repeated name coalesces
        // into a single comma-joined entry, which is not a header flood at all.
        for (let i = 0; i < route.headerFlood; i += 1) {
          headers.append(`x-junk-${i}`, `${i}`.padEnd(64, "-"));
        }
      }

      if (route.trickle) {
        // Never completes on its own. Only the guard's abort signal ends it,
        // which is exactly the property under test.
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const tick = setInterval(() => {
              try {
                controller.enqueue(new TextEncoder().encode("."));
              } catch {
                clearInterval(tick);
              }
            }, 5);
            init.signal.addEventListener("abort", () => {
              clearInterval(tick);
              controller.error(new DOMException("Aborted", "AbortError"));
            });
          },
        });
        return new Response(stream, { status: route.status ?? 200, headers });
      }

      if (init.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const body = route.bytes ? "A".repeat(route.bytes) : (route.body ?? "");

      return new Response(route.status === 204 ? null : body, {
        status: route.status ?? 200,
        headers,
      });
    },
  };
}

/** The response table the hostile URL rows describe. */
export function hostileConnector(): ScriptedConnector {
  return scriptedConnector({
    "api.example.com/v1/geocode": { status: 402, body: "{}" },
    "api.example.com/v1": { status: 402, body: "{}" },

    "redirector.example.net/to-internal": {
      status: 302,
      headers: { location: "http://10.0.0.5/" },
    },
    "redirector.example.net/to-http": {
      status: 302,
      headers: { location: "http://public.example.net/x" },
    },
    "redirector.example.net/loop": {
      status: 302,
      headers: { location: "https://redirector.example.net/loop" },
    },
    "redirector.example.net/once": {
      status: 302,
      headers: { location: "https://api.example.com/v1/geocode" },
    },

    "slowloris.example.net/huge": { status: 200, bytes: 2_000_000 },
    "slowloris.example.net/slow": { status: 200, trickle: true },
    "slowloris.example.net/headers": { status: 200, headerFlood: 400, body: "{}" },
  });
}
