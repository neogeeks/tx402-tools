import { html, raw, join } from "./html.js";

/**
 * Site header. The nav is the tool list, in the order a developer meets them:
 * inspect what an endpoint charges, verify a challenge before signing, try a
 * policy, then the corpus tools.
 */

export interface NavItem {
  href: string;
  label: string;
}

export const NAV: readonly NavItem[] = [
  { href: "/inspect", label: "Inspect" },
  { href: "/verify", label: "Verify" },
  { href: "/policy", label: "Policy" },
  { href: "/history", label: "History" },
  { href: "/compare", label: "Compare" },
  { href: "/replay", label: "Replay" },
];

/**
 * The tx402 mark, lifted verbatim from tx402-landing's header.
 *
 * It strokes with `currentColor`, which is why it can be inlined here without
 * tripping `pnpm gate:tokens` and why it follows the theme — and the link
 * colour — for free. Keep it that way: the moment someone hardcodes a stroke
 * colour, the light theme gets an invisible logo.
 */
export const BRAND_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h5l2.5-5 3 10 2.5-5h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/** The menu glyph. `currentColor` again, so it follows the theme for free. */
const MENU_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

/**
 * The mobile menu is a checkbox, and it holds its own state in CSS.
 *
 * ── Why not `<details>`, which has better semantics ────────────────────────
 *
 * Because it cannot serve both breakpoints. A `<details>` that is CLOSED has
 * its contents skipped for layout by the browser, and author CSS cannot bring
 * them back: measured in Chromium at 1280px, the same nav is 361px wide when
 * `open` and **0px** when not, whether the details is `display: contents` or
 * `display: flex`. So a single `<details>` is either a working desktop nav or
 * a working mobile menu, never both, unless a script forces `open` — and that
 * is the dependency this avoids.
 *
 * ── Why not JavaScript ─────────────────────────────────────────────────────
 *
 * `app.js` is progressive enhancement — these pages render server-side and
 * work without it. A menu that needs a script to open is a menu that vanishes
 * when the script does not load, taking the whole site's navigation with it.
 * `:checked` needs nothing.
 *
 * ── The accessibility trade, stated plainly ────────────────────────────────
 *
 * A checkbox announces "Menu, checkbox, not checked" rather than a button with
 * `aria-expanded`. It conveys the same state in different words. The checkbox
 * is visually hidden but **still focusable** — never `display: none` — so it is
 * reachable by keyboard and toggles on Space, and the `<label>` beside it is
 * `aria-hidden` so the control is announced once, not twice.
 */
export function header(currentPath = "/"): string {
  const links = NAV.map((item) => {
    const current = currentPath === item.href || currentPath.startsWith(`${item.href}/`);
    return html`<a href="${item.href}"${raw(current ? ' aria-current="page"' : "")}>${item.label}</a>`;
  });

  return html`
    <header class="site-header">
      <div class="wrap">
        <a class="brand" href="/" aria-label="tx402 tools — home">
          ${raw(BRAND_MARK)} tx402 <span class="brand-sub">tools</span>
        </a>
        <input type="checkbox" id="nav-open" class="nav-checkbox" aria-label="Menu" />
        <label for="nav-open" class="nav-toggle" aria-hidden="true">${raw(MENU_MARK)}</label>
        <nav class="nav" aria-label="Tools">${join(links, "")}</nav>
        ${raw(themeToggle())}
      </div>
    </header>
  `;
}

/**
 * Theme toggle.
 *
 * Both icons ship in the markup and CSS decides which is visible, so the button
 * is correct on first paint with no JavaScript having run — the same approach
 * tx402-landing uses. `aria-label` is static ("Switch theme") rather than
 * describing the current state, because the state is already carried by the
 * icon and a label that flips mid-interaction is worse for screen readers than
 * one that does not.
 *
 * The stored preference is a single localStorage key. No cookie, no visitor
 * identifier.
 */
function themeToggle(): string {
  return html`
    <button type="button" class="theme-toggle" data-theme-toggle aria-label="Switch theme">
      <svg class="icon-sun" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg class="icon-moon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
      </svg>
    </button>
  `;
}
