import { html, raw, join } from "./html.js";

/**
 * Key/value table.
 *
 * The `unobserved` path is the point of this component. A row whose value we
 * could not determine renders as "not observed" in muted italics — never as a
 * blank cell, a dash, or `false`. SPEC §6.3: conflating "we saw nothing" with
 * "we saw a problem" is how a trust tool starts crying wolf.
 */

export interface KvRow {
  label: string;
  /** `null`/`undefined` renders as the unobserved state unless `emptyText` is given. */
  value?: string | number | null;
  /** Render the value with the body font instead of the mono font. */
  prose?: boolean;
  /** Pre-rendered HTML (a pill, a link). Bypasses escaping — never pass user input. */
  valueHtml?: string;
  /** Small note under the value. */
  note?: string;
  /** What to show when the value is absent. Defaults to "not observed". */
  emptyText?: string;
}

export function kvTable(rows: KvRow[], caption?: string): string {
  const body = rows.map((row) => {
    const hasValue = row.valueHtml !== undefined || (row.value !== null && row.value !== undefined && row.value !== "");

    const cell = hasValue
      ? html`<td class="${raw(row.prose ? "prose" : "")}"
          >${raw(row.valueHtml ?? html`${row.value}`)}${raw(
            row.note ? html`<span class="kv-note">${row.note}</span>` : "",
          )}</td
        >`
      : html`<td class="unobserved">${row.emptyText ?? "not observed"}</td>`;

    return html`<tr>
      <th scope="row">${row.label}</th>
      ${raw(cell)}
    </tr>`;
  });

  return html`<div class="table-scroll">
    <table class="kv">
      ${raw(caption ? html`<caption class="visually-hidden">${caption}</caption>` : "")}
      <tbody>
        ${join(body)}
      </tbody>
    </table>
  </div>`;
}
