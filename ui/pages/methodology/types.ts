/**
 * The claim contract, as the methodology page needs to describe it.
 *
 * `/methodology` is the human surface for a flow whose routes are JSON-only
 * (`worker/router.ts` declares every `/api/v1/claim*` route with
 * `negotiated: false`), exactly the way `/crawler` is the human surface for
 * `POST /api/v1/optout`. The constants come from `worker/routes/claim-proof.ts`
 * so the page cannot document a record name the verifier does not look for.
 */

export interface ClaimDocs {
  /** Public origin of this deployment, so copy-pasted curl lines actually run. */
  origin: string;
  /** The DNS TXT name an operator publishes under, e.g. `_x402-tools`. */
  txtName: string;
  /** The well-known path carrying the claim token. */
  wellKnown: string;
  /** The well-known path that opts an origin out without talking to us. */
  optoutWellKnown: string;
  /** How long a pending token stays verifiable. */
  tokenTtlHours: number;
  /** The method the documented example uses. */
  defaultMethod: "dns-txt" | "well-known";
}
