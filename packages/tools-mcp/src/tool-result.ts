/**
 * What a `tools/call` returns, and the one rule about `isError`.
 *
 * MCP has two ways to fail, and they mean different things to a model. A
 * JSON-RPC error says "the call itself was not valid" and is handled by the
 * client. `isError: true` inside a normal result says "the tool ran and could
 * not answer", and is handed to the model to reason about — which is exactly
 * what we want for "we could not reach the service", because the model's next
 * move (retry, ask the user, decline to pay) depends on knowing that.
 *
 * The rule this file exists to make hard to break: **`isError: true` means we
 * do not have an answer.** It is never used for a negative finding. An endpoint
 * that serves a broken challenge, an endpoint we have never seen, an endpoint
 * that is not x402 at all — those are answers, they come back with
 * `isError: false`, and SPEC §3.1 gives the last two HTTP 200 for the same
 * reason. Marking a finding as an error would tell a model that its question
 * failed, when in fact its question was answered and the answer was "do not pay
 * this".
 */

export interface TextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  /**
   * The same answer as data. No `outputSchema` is declared for either tool, so
   * a client that understands this field gets the structured form and one that
   * does not loses nothing — the text block is complete on its own.
   */
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** An answer. */
export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text }], isError: false };
  if (structured) result.structuredContent = structured;
  return result;
}

/**
 * Not an answer.
 *
 * The text says what we do not know rather than what we suspect, because the
 * one failure that would actually cost somebody money here is a fabricated
 * verdict dressed as a real one.
 */
export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
