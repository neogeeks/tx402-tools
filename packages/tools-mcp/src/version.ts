/**
 * Identity, and the sentence an operator should be able to read before they
 * trust this thing.
 *
 * The name is `tx402-tools-mcp` and it is not negotiable: `tx402-mcp` is taken
 * by an unrelated project, and both of our names were reserved
 * with a `0.0.0` placeholder publish and granted (O14).
 */

export const SERVER_NAME = "tx402-tools-mcp";
export const SERVER_TITLE = "tx402 tools — x402 endpoint inspector and challenge verifier";
export const SERVER_VERSION = "0.1.0";

/**
 * Returned in `initialize` as `instructions`, and repeated in both tool
 * descriptions.
 *
 * says this repository can never construct a payment, and
 * `pnpm gate:no-signer` enforces the shape of that claim in CI rather than
 * trusting a promise in a document. The claim is stated here because the person
 * installing an MCP server into an agent that holds a wallet deserves to see,
 * in the server's own description, that the tool they just installed reads
 * challenges and cannot spend.
 */
export const SERVER_INSTRUCTIONS = [
  "tx402 tools answers two questions about x402 payment endpoints, for an agent that is deciding",
  "whether to pay one.",
  "",
  "  inspect_endpoint   What does this endpoint charge, on which network, to whom — and what has",
  "                     tools.tx402.io observed about it before? Contacts the hosted service.",
  "  verify_challenge   Is this payment challenge well-formed and internally consistent? Runs",
  "                     entirely on this machine and makes no network request.",
  "",
  "This server cannot pay. It holds no keys, constructs no payment authorization, and has no signer:",
  "the repository it is built from is scanned in CI for the shape of key material and of signature",
  "construction, and the build fails if either appears. It reads the public payment challenge an",
  "endpoint serves to anyone who asks, and stops.",
  "",
  "It also has nothing to sign in to. There is no account, no API key and no token anywhere in this",
  "product; the hosted API is public and rate-limited per endpoint, not per caller.",
  "",
  "How to read what comes back: everything reported is an observation about a challenge or an",
  "endpoint's public behaviour, never a claim about whoever operates it. A check reported as SKIP",
  "could not run and is not a check that passed. A signal reported as not observed is something we",
  "could not determine, not a negative finding. An endpoint with no history is a new endpoint, not a",
  "suspicious one.",
].join("\n");
