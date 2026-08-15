/**
 * Ambient declarations for the non-TypeScript modules the Worker imports.
 *
 * CSS is imported as text via the `rules` entry in wrangler.jsonc, which lets
 * `ui/tokens.css` stay at the canonical path gives it instead of
 * being copied into./public by a build step.
 */

declare module "*.css" {
  const content: string;
  export default content;
}
