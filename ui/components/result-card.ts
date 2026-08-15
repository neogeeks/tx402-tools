import { html, raw } from "./html.js";

/** Result card: the container every tool's findings sit in. */

export interface ResultCardOptions {
  title: string;
  /** Pre-rendered HTML for the card body. */
  body: string;
  /** Pre-rendered HTML shown next to the title, typically a status pill. */
  badge?: string;
  /** Right-aligned note in the header, e.g. "observed 12s ago". */
  aside?: string;
  /** Footer line, e.g. a link to the methodology or the raw JSON. */
  footer?: string;
  /** Heading id, so a permalink can target this card. */
  id?: string;
}

export function resultCard(opts: ResultCardOptions): string {
  return html`<section class="card"${raw(opts.id ? html` id="${opts.id}"` : "")}>
    <header>
      <h2>${opts.title}</h2>
      ${raw(opts.badge ?? "")} ${raw(opts.aside ? html`<span class="card-aside">${opts.aside}</span>` : "")}
    </header>
    <div class="card-body">${raw(opts.body)}</div>
    ${raw(opts.footer ? html`<footer>${raw(opts.footer)}</footer>` : "")}
  </section>`;
}
