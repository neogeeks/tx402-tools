/**
 * The package surface, for the bin and for `test/mcp.test.ts`.
 *
 * The tests drive `Server.handle` — the same function the stdio transport calls
 * for every line it reads — rather than a parallel harness, so a `tools/list`
 * that passes in the suite is the `tools/list` a client receives.
 */

export { HostedClient, baseUrlFromEnv, DEFAULT_BASE_URL, BASE_URL_ENV_VAR, FINDING_CODES } from "./hosted.js";
export type { FetchLike, HostedOutcome, HostedClientOptions } from "./hosted.js";
export { Server, handleLine, LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, JSON_RPC_ERRORS } from "./server.js";
export type { JsonRpcResponse, JsonRpcId } from "./server.js";
export { main, serve } from "./stdio.js";
export type { StdioStreams } from "./stdio.js";
export { TOOLS, TOOL_NAMES } from "./tools.js";
export type { ToolDefinition } from "./tools.js";
export { runInspectEndpoint } from "./inspect.js";
export { runVerifyChallenge } from "./verify.js";
export type { ToolResult } from "./tool-result.js";
export { validateAgainst, VALIDATED_SCHEMAS, VERIFY_DATA_SCHEMA_ID } from "./schemas.js";
export {
  BAND_FRAMING,
  FORBIDDEN_TERMS,
  LIST_FRAMING,
  NO_HISTORY_FRAMING,
  SKIP_FRAMING,
  UNOBSERVED_FRAMING,
  forbiddenTermsIn,
} from "./language.js";
export {
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  SERVER_TITLE,
  SERVER_VERSION,
} from "./version.js";
