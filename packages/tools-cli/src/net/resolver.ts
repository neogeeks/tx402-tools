/**
 * The Node resolver.
 *
 * `worker/lib/guard.ts` declares `Resolver` as a port for two reasons, and this
 * is the second one: the Worker has no DNS API and resolves over DNS-over-HTTPS,
 * while a CLI has `node:dns` and can see the same answer the kernel is about to
 * use. That difference is not cosmetic — it is what makes the pin in
 * `connector.ts` enforceable here and unenforceable there.
 *
 * `dns.lookup` is deliberately NOT what this uses. `lookup` goes through
 * `getaddrinfo`, which consults `/etc/hosts`, mDNS and NSS modules and returns
 * whatever the platform decides — useful for a normal client, useless for a
 * guard that has to know the RRset it is validating is the RRset the socket
 * will use. `dns.resolve4/6` asks the configured DNS servers directly and
 * returns the records themselves.
 *
 * The exception is a `.localhost` name and `localhost` itself, which have no
 * DNS records at all on most machines: RFC 6761 reserves them for loopback and
 * the resolver answers them from the stack. Those are resolved from the
 * hosts-file path on purpose, and only reach the network when the caller has
 * already opted into private space.
 */

import { Resolver as NodeDnsResolver, promises as dnsPromises } from "node:dns";

import type { Resolver } from "../../../../worker/lib/guard.js";

/** RFC 6761 §6.3: `localhost.` and anything under it is loopback, by definition. */
export function isLoopbackName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  return host === "localhost" || host.endsWith(".localhost");
}

export interface NodeResolverOptions {
  /** Override the DNS servers, e.g. in a test or on a split-horizon network. */
  servers?: string[];
  /** Per-query budget. A resolver that hangs is a probe that hangs. */
  timeoutMs?: number;
}

/**
 * Resolve A and AAAA records with `node:dns`, returning both families in one
 * list — which is what `resolveAndValidate` wants, because it insists that
 * **every** record be public before any of them is used.
 */
export function nodeResolver(options: NodeResolverOptions = {}): Resolver {
  const resolver = new NodeDnsResolver({ timeout: options.timeoutMs ?? 5_000, tries: 2 });
  if (options.servers && options.servers.length > 0) resolver.setServers(options.servers);

  const resolveFamily = (hostname: string, family: 4 | 6): Promise<string[]> =>
    new Promise((resolve) => {
      const done = (error: unknown, records?: string[]) => {
        // An empty answer is not an error here: a host with only A records
        // legitimately has no AAAA, and treating NODATA as a failure would
        // refuse half the internet.
        resolve(error || !records ? [] : records);
      };
      if (family === 4) resolver.resolve4(hostname, done);
      else resolver.resolve6(hostname, done);
    });

  return {
    async resolve(hostname: string): Promise<string[]> {
      if (isLoopbackName(hostname)) {
        // `lookup` is correct here and only here — these names are answered by
        // the stack, not by DNS, and the addresses it returns are the ones the
        // socket would use.
        const entries = await dnsPromises.lookup(hostname, { all: true });
        return entries.map((entry) => entry.address);
      }

      const [v4, v6] = await Promise.all([
        resolveFamily(hostname, 4),
        resolveFamily(hostname, 6),
      ]);
      return [...v4, ...v6];
    },
  };
}
