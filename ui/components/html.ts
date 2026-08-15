/**
 * HTML string helpers.
 *
 * Every component in this directory returns an HTML string. There is no
 * framework and no build step: the Worker renders the page, so one handler
 * produces all three representations of a result (SPEC §1.2) and the JSON, the
 * Markdown and the HTML cannot drift apart.
 *
 * The consequence is that escaping is manual, so it is centralised here and
 * every component uses it. Interpolating an unescaped string into a page that
 * displays merchant-controlled challenge text is how this becomes an XSS
 * surface.
 */

/** Escape for HTML text and quoted-attribute contexts. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Marks a string as already-safe HTML.
 *
 * The `html` tagged template escapes every interpolation by default. Wrap a
 * value in `raw` only when it is HTML you produced yourself — a nested
 * component's output, never anything derived from a request or a probed
 * endpoint.
 */
export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): Raw {
  return new Raw(value);
}

/** Tagged template that escapes interpolations unless they are `Raw`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    out += v instanceof Raw ? v.value : escapeHtml(v ?? "");
    out += strings[i + 1] ?? "";
  }
  return out;
}

/** Join pre-rendered fragments. */
export function join(parts: Array<string | Raw>, separator = "\n"): Raw {
  return raw(parts.map((p) => (p instanceof Raw ? p.value : p)).join(separator));
}

/** Render a conditional fragment without leaking `false`/`undefined` into the page. */
export function when(condition: unknown, fragment: string | Raw): Raw {
  return condition ? raw(fragment instanceof Raw ? fragment.value : fragment) : raw("");
}
