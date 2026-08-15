/**
 * stdio transport: newline-delimited JSON-RPC on stdin and stdout.
 *
 * Two rules that are easy to get wrong and impossible to debug afterwards:
 *
 * **Nothing but JSON-RPC goes to stdout, ever.** stdout is the wire. A stray
 * `console.log` is a corrupt frame, and the client's failure mode is a silent
 * hang rather than an error. Diagnostics go to stderr, where the client shows
 * them in its MCP log.
 *
 * **A message is one line.** `JSON.stringify` never emits a newline inside a
 * string literal — it escapes them — so a single `\n` terminator is unambiguous
 * even though every string this server returns is full of line breaks.
 */

import { HostedClient, baseUrlFromEnv, DEFAULT_BASE_URL } from "./hosted.js";
import { Server, handleLine } from "./server.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

export interface StdioStreams {
  stdin: AsyncIterable<string | Uint8Array>;
  write: (line: string) => void;
  log: (line: string) => void;
}

/**
 * Run the server against a pair of streams until stdin ends.
 *
 * Requests are handled **sequentially**. The alternative — dispatching each
 * line without awaiting — would let a slow `inspect_endpoint` interleave with a
 * fast `verify_challenge`, which JSON-RPC permits and this server has no reason
 * to want: there are two tools, one of them is local and instant, and ordered
 * handling makes the transcript in a client's MCP log readable.
 */
export async function serve(streams: StdioStreams, server: Server): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of streams.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        const response = await handleLine(server, line);
        if (response) streams.write(`${JSON.stringify(response)}\n`);
      }
      newline = buffer.indexOf("\n");
    }
  }

  // A final line with no trailing newline is still a message. Clients close the
  // pipe on shutdown and some do it without a terminator.
  const last = buffer.trim();
  if (last.length > 0) {
    const response = await handleLine(server, last);
    if (response) streams.write(`${JSON.stringify(response)}\n`);
  }
}

/**
 * The entry point the bin calls.
 *
 * Reads only one environment variable, and it is not a credential — there are
 * none in this product. `TX402_TOOLS_API` points the client at
 * a local `wrangler dev` instead of production, which is the only supported
 * reason to change it.
 */
export async function main(
  env: Record<string, string | undefined>,
  streams: StdioStreams,
): Promise<void> {
  const baseUrl = baseUrlFromEnv(env);
  streams.log(
    `${SERVER_NAME} ${SERVER_VERSION} on stdio · hosted API ${baseUrl}` +
      (baseUrl === DEFAULT_BASE_URL ? "" : ` (overridden via TX402_TOOLS_API)`) +
      " · this server holds no keys and cannot pay",
  );
  await serve(streams, new Server({ client: new HostedClient({ baseUrl }) }));
}
