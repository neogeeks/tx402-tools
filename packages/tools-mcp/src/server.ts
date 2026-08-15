/**
 * The MCP server: JSON-RPC 2.0 request handling, transport-independent.
 *
 * ── Why this is hand-written and has no runtime protocol dependency ────────
 *
 * MCP over stdio is newline-delimited JSON-RPC 2.0 with five methods that
 * matter, and all five are below. Taking a dependency on the reference SDK
 * would have added a package tree to a tool whose entire pitch is "you can read
 * this and see that it cannot spend your money" — an operator installing an MCP
 * server into an agent that holds a wallet is entitled to audit it, and the
 * shortest honest audit is one file per concern and no transitive code.
 * `ajv` is the only runtime dependency that is not `tx402` itself, and it is
 * here to *refuse* malformed answers.
 *
 * The cost of hand-writing it is interoperability risk, which is not a thing to
 * argue about in a comment:. records this server being driven by
 * a real client, with the transcript, because "passes its unit tests" is not
 * the same claim as "works in Claude Code".
 *
 * ── The two ways to fail, kept distinct ────────────────────────────────────
 *
 * A JSON-RPC error means the *call* was not valid — unknown method, bad params
 * — and the client handles it. A result carrying `isError: true` means the tool
 * ran and could not answer, and the model handles it. "tools.tx402.io is
 * unreachable" is emphatically the second: the model needs to know it asked and
 * got nothing, because its next move depends on that. See `tool-result.ts`.
 */

import { HostedClient } from "./hosted.js";
import { runInspectEndpoint } from "./inspect.js";
import type { ToolResult } from "./tool-result.js";
import { errorResult } from "./tool-result.js";
import { TOOLS } from "./tools.js";
import { runVerifyChallenge } from "./verify.js";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from "./version.js";

export const LATEST_PROTOCOL_VERSION = "2025-06-18";

/** Versions this server can speak. Ordered newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export const JSON_RPC_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ServerOptions {
  client?: HostedClient;
}

export class Server {
  readonly #client: HostedClient;

  constructor(options: ServerOptions = {}) {
    this.#client = options.client ?? new HostedClient();
  }

  /**
   * Handle one decoded JSON-RPC message.
   *
   * Returns `null` for a notification — a message with no `id`. A notification
   * that gets a response is a protocol violation that some clients tolerate and
   * some do not, so the distinction is made here rather than at the transport.
   */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return errorResponse(null, JSON_RPC_ERRORS.invalidRequest, "Expected a JSON-RPC object.");
    }

    const { id, method, params } = message as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };

    if (typeof method !== "string") {
      return errorResponse(idOf(id), JSON_RPC_ERRORS.invalidRequest, "Missing `method`.");
    }

    const isNotification = id === undefined || id === null;

    if (isNotification) {
      // `notifications/initialized`, `notifications/cancelled` and anything else
      // a client sends without an id: acknowledged by silence, which is what the
      // protocol asks for.
      return null;
    }

    const responseId = idOf(id);

    try {
      switch (method) {
        case "initialize":
          return ok(responseId, this.#initialize(params));
        case "ping":
          return ok(responseId, {});
        case "tools/list":
          return ok(responseId, { tools: TOOLS });
        case "tools/call":
          return ok(responseId, await this.#callTool(params));
        default:
          return errorResponse(
            responseId,
            JSON_RPC_ERRORS.methodNotFound,
            `This server does not implement "${method}". It implements initialize, ping, tools/list and tools/call.`,
          );
      }
    } catch (error) {
      // A throw here is our bug, and the message says only that. Nothing about
      // the caller's input and nothing about this machine goes back out.
      return errorResponse(
        responseId,
        JSON_RPC_ERRORS.internal,
        `The server failed to handle "${method}" (${error instanceof Error ? error.name : "unknown error"}).`,
      );
    }
  }

  #initialize(params: unknown): Record<string, unknown> {
    const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
    // Echo the client's version when we speak it; otherwise answer with ours and
    // let the client decide. Guessing agreement is how a session hangs.
    const protocolVersion =
      typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;

    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: SERVER_TITLE, version: SERVER_VERSION },
      instructions: SERVER_INSTRUCTIONS,
    };
  }

  async #callTool(params: unknown): Promise<ToolResult> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };

    if (typeof name !== "string") {
      return errorResult("No tool name was supplied. Send `params.name`.");
    }

    const supplied: Record<string, unknown> =
      typeof args === "object" && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {};

    switch (name) {
      case "inspect_endpoint":
        return runInspectEndpoint(supplied, this.#client);
      case "verify_challenge":
        return runVerifyChallenge(supplied);
      default:
        // A tool error rather than a JSON-RPC error: a model that guessed a name
        // can read this and correct itself, whereas a protocol error is handled
        // by the client and may never reach it.
        return errorResult(
          `There is no tool named "${name}" on this server. It provides inspect_endpoint and verify_challenge.`,
        );
    }
  }
}

function idOf(id: unknown): JsonRpcId {
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Decode one line and hand it to the server.
 *
 * A line that is not JSON gets a parse error with a null id, which is what the
 * JSON-RPC specification asks for and what lets a client resynchronise instead
 * of waiting forever for a response it will never get.
 */
export async function handleLine(server: Server, line: string): Promise<JsonRpcResponse | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return errorResponse(null, JSON_RPC_ERRORS.parse, "The message was not valid JSON.");
  }
  return server.handle(message);
}
