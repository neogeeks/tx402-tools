/**
 * /assets/*.
 *
 * `ui/tokens.css` and `ui/components.css` are imported as text (the `rules` entry in
 * wrangler.jsonc) and served from here, which keeps them at the canonical paths gives them instead
 * of duplicating them into. /public at build time. One copy, no sync step, and `pnpm gate:tokens`
 * has exactly one file to exempt.
 *
 * URLs are content-hashed — `/assets/tokens.a1b2c3d4.css` — so they can be
 * cached immutably and STILL update the instant a deploy changes the file. The
 * alternative (a stable URL with a long max-age) means every UI session ships a
 * change and then sees the old stylesheet; that happened once during and is
 * exactly the kind of thing that gets misdiagnosed as a CSS bug.
 */

import { errorResponse, text } from "../http.js";
import type { RouteContext, RouteHandler } from "../types.js";

import tokensCss from "../../ui/tokens.css";
import componentsCss from "../../ui/components.css";

const APP_JS = `// Progressive enhancement only. The pages work without this file.
(function () {
  // Theme toggle. Reads what is ACTUALLY rendering — including the system
  // preference when no explicit choice has been stored — so the first click
  // always flips to the opposite of what the user is looking at, rather than
  // appearing to do nothing.
  document.addEventListener('click', function (e) {
    var toggle = e.target instanceof Element ? e.target.closest('[data-theme-toggle]') : null;
    if (!toggle) return;
    var root = document.documentElement;
    var explicit = root.getAttribute('data-theme');
    var current = explicit || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    var next = current === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('tx402-theme', next); } catch (err) {}
  });

  document.addEventListener('click', function (e) {
    var btn = e.target instanceof Element ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    var block = btn.closest('.code');
    var code = block && block.querySelector('code');
    if (!code || !navigator.clipboard) return;
    navigator.clipboard.writeText(code.textContent || '').then(function () {
      var previous = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = previous; }, 1200);
    });
  });
})();
`;

const FILES: Record<string, { body: string; type: string }> = {
  "tokens.css": { body: tokensCss, type: "text/css; charset=utf-8" },
  "components.css": { body: componentsCss, type: "text/css; charset=utf-8" },
  "app.js": { body: APP_JS, type: "text/javascript; charset=utf-8" },
};

/**
 * FNV-1a. This is a cache key, not a security boundary — it needs to be stable,
 * synchronous at module load, and different when the bytes differ. A crypto
 * digest would need top-level await for no benefit.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const HASHES: Record<string, string> = Object.fromEntries(
  Object.entries(FILES).map(([name, file]) => [name, hash(file.body)]),
);

/** `tokens.css` → `/assets/tokens.a1b2c3d4.css`. Used by the page shell. */
export function assetUrl(name: string): string {
  const h = HASHES[name];
  if (!h) return `/assets/${name}`;
  const dot = name.lastIndexOf(".");
  return `/assets/${name.slice(0, dot)}.${h}${name.slice(dot)}`;
}

/** `tokens.a1b2c3d4.css` → `tokens.css`. Unhashed names still resolve. */
function stripHash(requested: string): string {
  const parts = requested.split(".");
  if (parts.length >= 3 && /^[0-9a-f]{8}$/.test(parts[parts.length - 2] ?? "")) {
    parts.splice(parts.length - 2, 1);
  }
  return parts.join(".");
}

export const assets: RouteHandler = (ctx: RouteContext): Response => {
  const requested = ctx.params.name ?? "";
  const name = stripHash(requested);
  const file = FILES[name];
  if (!file) return errorResponse("NOT_FOUND");

  const isHashed = requested !== name;
  return text(file.body, file.type, {
    headers: {
      // A hashed URL can never be wrong, so cache it forever. An unhashed one
      // has to stay cheap to correct.
      "cache-control": isHashed
        ? "public, max-age=31536000, immutable"
        : "public, max-age=60, must-revalidate",
      etag: `"${HASHES[name] ?? ""}"`,
    },
  });
};
