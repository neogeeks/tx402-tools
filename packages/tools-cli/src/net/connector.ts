/**
 * The pinning connector — its answer to **O21**.
 *
 * ── What O21 says, and what this changes ───────────────────────────────────
 *
 * requires the guard to **pin the resolved address for the actual
 * connection**, so that a name which validated as public cannot be re-resolved
 * to a private address between the check and the connect (DNS rebinding).
 * We established that a Cloudflare Worker cannot do it: no DNS API, `fetch`
 * re-resolves independently of whatever DoH returned, and `connect` from
 * `cloudflare:sockets` exposes only `secureTransport` and `allowHalfOpen` —
 * no SNI field — so dialling a validated IP literal fails certificate
 * validation for any normal certificate. `Connector` therefore became a port
 * carrying a `PinnedTarget` the hosted connector accepts and cannot honour.
 *
 * **Node can honour it, and this file does.** The mechanism is one option:
 *
 *   - `lookup` is overridden to a function that ignores its hostname argument
 *     and hands back the address the guard already validated. `net.connect`
 *     calls it instead of `getaddrinfo`, so the socket goes to that address
 *     and to no other. There is no second resolution to lose a race with.
 *   - `servername` stays the **hostname**, so TLS still performs SNI and
 *     certificate validation against the name the user asked for. This is the
 *     part `cloudflare:sockets` cannot express, and it is why dialling an IP
 *     literal is not a substitute: pinning by URL rewriting breaks TLS, and
 *     pinning by `lookup` does not.
 *
 * So the TOCTOU window O21 describes — between the guard's second lookup and
 * the platform's own — **does not exist on this path**. The guard resolves,
 * validates every record in the RRset, picks one, and this connector connects
 * to exactly that address.
 *
 * ── What it does NOT close ─────────────────────────────────────────────────
 *
 * Only the CLI. `worker/lib/guard.ts`'s `workerConnector` is unchanged and
 * still cannot pin, so O21 stays open for the hosted probe and its red-team
 * still owns re-testing it there.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";

import { parseAddress } from "../../../../worker/lib/guard.js";
import type { Connector, PinnedTarget } from "../../../../worker/lib/guard.js";

/** Recorded per hop so the tests — and `--explain` — can assert what happened. */
export interface PinRecord {
  hostname: string;
  port: number;
  /** The address the socket was actually bound to. */
  address: string;
  /** The name TLS validated against, or null on `http:`. */
  servername: string | null;
}

export interface PinningConnector extends Connector {
  /** Every hop, in order. */
  readonly pins: PinRecord[];
}

/**
 * A `lookup` implementation that always answers with the pinned address.
 *
 * `net.connect` calls this with `(hostname, options, callback)` and expects
 * either `(err, address, family)` or, when `options.all` is set, an array of
 * `{address, family}`. Both shapes are answered, because which one is used is
 * an implementation detail of the Node version underneath.
 */
type LookupArgs = [string, unknown, unknown?];

function pinnedLookup(pin: PinnedTarget) {
  // Typed loosely and cast at the call site: Node's `LookupFunction` describes
  // only the single-address overload, while `net.connect` may pass `all: true`
  // and expect an array. Answering both shapes is correct for every Node
  // version this package supports; declaring both is not expressible.
  return (...args: LookupArgs): void => {
    const [, second, third] = args;
    const cb = (typeof second === "function" ? second : third) as
      | ((error: null, address: unknown, family?: number) => void)
      | undefined;
    const all = typeof second === "object" && second !== null && (second as { all?: boolean }).all === true;
    if (!cb) return;
    const address = pin.address.text;
    const family = pin.address.family;
    if (all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * Node's `IncomingMessage` as a `Response`.
 *
 * The guard reads bodies through `response.body.getReader` and aborts the
 * stream at the byte cap rather than buffering and measuring afterwards, so
 * the body must arrive as a real stream. `Readable.toWeb` gives one; buffering
 * here would silently undo the guard's amplification defence.
 */
function toWebResponse(
  status: number,
  rawHeaders: NodeJS.Dict<string | string[]>,
  stream: Readable,
): Response {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else headers.append(key, value);
  }

  // 204/304 carry no body, and constructing a Response with one throws.
  // The cast crosses the one seam this package has: `node:stream/web`'s
  // `ReadableStream` and the Workers/undici one are the same object at
  // runtime and two unrelated declarations at compile time.
  const body =
    status === 204 || status === 304
      ? null
      : (Readable.toWeb(stream) as unknown as ReadableStream);
  return new Response(body, { status, headers });
}

export interface NodeConnectorOptions {
  /**
   * Certificate validation. On by default and only turned off by an explicit
   * flag, which the README documents as the thing you use against your own
   * self-signed dev server and nothing else.
   */
  rejectUnauthorized?: boolean;
}

/**
 * The connector. One hop, no redirects followed — the guard follows them
 * itself so that every hop is re-validated and re-pinned.
 */
export function nodeConnector(options: NodeConnectorOptions = {}): PinningConnector {
  const pins: PinRecord[] = [];

  return {
    pins,
    fetch(url, init, pin) {
      const secure = url.protocol === "https:";
      const send = secure ? httpsRequest : httpRequest;

      // SNI is a hostname extension: sending an IP literal in it is invalid,
      // and Node's default (omit it, validate the cert against the IP) is the
      // correct behaviour for a URL that names an address directly.
      const servername = parseAddress(pin.hostname) === null ? pin.hostname : null;

      pins.push({
        hostname: pin.hostname,
        port: pin.port,
        address: pin.address.text,
        servername,
      });

      return new Promise<Response>((resolve, reject) => {
        const req = send(
          {
            protocol: url.protocol,
            hostname: pin.hostname,
            port: pin.port,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            headers: init.headers,
            signal: init.signal,
            // ── the pin ──
            lookup: pinnedLookup(pin),
            ...(secure
              ? {
                  ...(servername === null ? {} : { servername }),
                  rejectUnauthorized: options.rejectUnauthorized !== false,
                }
              : {}),
          },
          (res) => {
            resolve(toWebResponse(res.statusCode ?? 0, res.headers, res));
          },
        );

        req.on("error", reject);
        req.end();
      });
    },
  };
}
