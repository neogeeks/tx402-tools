/**
 * The two charts, and the visual grammar that keeps them apart.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE GRAMMAR
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   EXACT solid stroke · filled markers · a dot for every real event
 *            a price change is a thing that happened, on a date
 *
 *   SAMPLED dashed stroke · hatched fill · every figure prefixed `≈`
 *            an availability ratio is an estimate from a sampled dataset
 *
 * The two are drawn in different marks, not just different colours, because
 * colour alone is not a distinction for a reader who cannot see it and is not a
 * distinction at all in a printout. split the storage; this file is
 * where a reader can see that the split exists.
 *
 * A third mark carries the state that is neither: **the part of the window
 * before we started observing is hatched out and labelled**, so a three-day-old
 * endpoint asked for ninety days shows three days of chart and eighty-seven
 * days of "we were not looking". Drawing a flat line to the left edge would
 * invent eighty-seven days of evidence.
 *
 * Every colour resolves through a token in `ui/tokens.css`; `pnpm gate:tokens`
 * fails the build on a literal. Charts are inline SVG with no script, so they
 * render identically for an agent fetching the HTML and a browser painting it.
 */

import { html, join, raw } from "../../components/index.js";
import {
  APPROX,
  formatDate,
  formatPrice,
  formatRatio,
  type AvailabilityPoint,
  type LatencyPoint,
  type PricePoint,
} from "./types.js";

const W = 720;
const H = 200;
const PAD = { top: 14, right: 16, bottom: 26, left: 56 };

const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

export interface Domain {
  /** Window start, in epoch ms. Always the left edge — see the header note. */
  from: number;
  /** "now", in epoch ms. */
  to: number;
  /** When our record begins, in epoch ms, or null when we have none. */
  firstSeen: number | null;
}

export function domainFrom(from: string, to: string, firstSeen: string | null): Domain {
  return {
    from: Date.parse(from),
    to: Date.parse(to),
    firstSeen: firstSeen ? Date.parse(firstSeen) : null,
  };
}

/** Clamped so a point established before the window still anchors the left edge. */
function x(at: number, domain: Domain): number {
  const span = Math.max(1, domain.to - domain.from);
  const ratio = Math.min(1, Math.max(0, (at - domain.from) / span));
  return PAD.left + ratio * PLOT_W;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The "we were not looking" region.
 *
 * Rendered as a hatched block with a label rather than left blank, because
 * blank space on a chart reads as zero and this is not zero — it is the absence
 * of observation, which is a different claim entirely (SPEC §6.3).
 */
function unobservedRegion(domain: Domain): string {
  if (domain.firstSeen === null || domain.firstSeen <= domain.from) return "";
  const edge = x(domain.firstSeen, domain);
  if (edge <= PAD.left + 2) return "";

  const width = edge - PAD.left;
  const label = `We were not observing this endpoint before ${formatDate(new Date(domain.firstSeen).toISOString())}`;

  return html`<g>
    <rect
      x="${round(PAD.left)}"
      y="${PAD.top}"
      width="${round(width)}"
      height="${PLOT_H}"
      fill="url(#hatch-idle)"
      stroke="var(--border)"
      stroke-dasharray="3 3"
    ><title>${label}</title></rect>
    ${raw(
      width > 150
        ? html`<text
            x="${round(PAD.left + width / 2)}"
            y="${round(PAD.top + PLOT_H / 2)}"
            text-anchor="middle"
            class="chart-void"
          >
            not observing yet
          </text>`
        : "",
    )}
  </g>`;
}

/** Defined once per chart; `url(#id)` is not a colour and the gate knows it. */
function patterns(): string {
  return html`<defs>
    <pattern id="hatch-idle" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" stroke-width="1.4" />
    </pattern>
    <pattern id="hatch-sampled" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="5" stroke="var(--accent)" stroke-width="2" />
    </pattern>
  </defs>`;
}

function axisDates(domain: Domain): string {
  const from = formatDate(new Date(domain.from).toISOString());
  const to = formatDate(new Date(domain.to).toISOString());
  return html`<g class="chart-axis">
    <text x="${PAD.left}" y="${H - 8}" text-anchor="start">${from}</text>
    <text x="${W - PAD.right}" y="${H - 8}" text-anchor="end">${to}</text>
  </g>`;
}

function frame(): string {
  return html`<g class="chart-frame">
    <line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + PLOT_H}" />
    <line
      x1="${PAD.left}"
      y1="${PAD.top + PLOT_H}"
      x2="${W - PAD.right}"
      y2="${PAD.top + PLOT_H}"
    />
  </g>`;
}

// ── price: EXACT ──────────────────────────────────────────────────────────

/**
 * A step chart, because that is what a price is.
 *
 * A price does not drift between observations — it holds at one value until we
 * observe it at another. An interpolated line between two price points would
 * draw a hundred intermediate prices that were never charged, on the one series
 * this tool holds out as evidence. So: horizontal holds, vertical steps, and a
 * filled marker at each moment we actually observed something.
 */
export function priceChart(points: readonly PricePoint[], domain: Domain): string {
  if (points.length === 0) return "";

  const values = points.map((p) => Number(p.amount_atomic)).filter((v) => Number.isFinite(v));
  if (values.length === 0) return "";

  const max = Math.max(...values);
  const min = Math.min(...values);
  // A flat series is a real answer here — "unchanged" — so it gets a padded
  // band rather than a degenerate zero-height axis.
  const top = max === min ? max * 1.3 || 1 : max + (max - min) * 0.25;
  const bottom = max === min ? Math.max(0, max * 0.7) : Math.max(0, min - (max - min) * 0.25);

  const y = (value: number): number => {
    const span = Math.max(1e-9, top - bottom);
    return PAD.top + PLOT_H - ((value - bottom) / span) * PLOT_H;
  };

  const segments: string[] = [];
  const markers: string[] = [];

  points.forEach((point, index) => {
    const value = Number(point.amount_atomic);
    if (!Number.isFinite(value)) return;

    const at = Date.parse(point.t);
    const startX = x(at, domain);
    const next = points[index + 1];
    const endX = next ? x(Date.parse(next.t), domain) : W - PAD.right;
    const atY = y(value);

    segments.push(
      html`<path
        d="M ${round(startX)} ${round(atY)} L ${round(endX)} ${round(atY)}"
        class="chart-line-exact"
      />`,
    );

    if (next) {
      const nextValue = Number(next.amount_atomic);
      if (Number.isFinite(nextValue)) {
        segments.push(
          html`<path
            d="M ${round(endX)} ${round(atY)} L ${round(endX)} ${round(y(nextValue))}"
            class="chart-line-exact"
          />`,
        );
      }
    }

    // The anchor point predates the window: it is the price carried in, not an
    // event that happened at the left edge, so it gets no event marker.
    if (at >= domain.from) {
      markers.push(
        html`<circle cx="${round(startX)}" cy="${round(atY)}" r="4" class="chart-dot-exact"
          ><title>${formatDate(point.t)} — ${formatPrice(point)}</title></circle
        >`,
      );
    }
  });

  const label = (value: number, at: number): string =>
    html`<text x="${PAD.left - 8}" y="${round(at + 4)}" text-anchor="end" class="chart-axis">${value}</text>`;

  return html`<figure class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Observed price over the selected window" preserveAspectRatio="none">
      ${raw(patterns())} ${raw(unobservedRegion(domain))} ${raw(frame())}
      ${raw(label(Math.round(top), y(top)))} ${raw(label(Math.round(bottom), y(bottom)))}
      ${join(segments)} ${join(markers)} ${raw(axisDates(domain))}
    </svg>
    <figcaption>
      Price in atomic units. Each marker is a change we observed, on the date we observed it. The line holds
      flat between observations because the price did.
    </figcaption>
  </figure>`;
}

// ── availability: SAMPLED ─────────────────────────────────────────────────

/**
 * Hatched bars, one per bucket.
 *
 * Bars rather than an area, and hatched rather than filled, because each bar is
 * an estimate over a bucket and not a reading at an instant. A bucket holding
 * few samples is drawn faint and says how few in its tooltip — a bar computed
 * from one probe and a bar computed from ninety-six should not look alike.
 */
export function availabilityChart(points: readonly AvailabilityPoint[], domain: Domain): string {
  if (points.length === 0) return "";

  const span = Math.max(1, domain.to - domain.from);
  const width = Math.max(2, (PLOT_W / Math.max(1, points.length)) * 0.72);
  const maxSamples = Math.max(...points.map((p) => p.samples), 1);

  const bars = points.map((point) => {
    const at = Date.parse(point.t);
    const left = PAD.left + Math.min(1, Math.max(0, (at - domain.from) / span)) * PLOT_W;
    const height = Math.max(1, point.ratio * PLOT_H);
    // Faint where the bucket is thin. A number computed from one sample is
    // still a number; it is just not one to lean on.
    const weight = Math.min(1, 0.35 + 0.65 * (point.samples / maxSamples));

    return html`<rect
      x="${round(Math.min(left, W - PAD.right - width))}"
      y="${round(PAD.top + PLOT_H - height)}"
      width="${round(width)}"
      height="${round(height)}"
      class="chart-bar-sampled"
      opacity="${round(weight)}"
    ><title>${formatDate(point.t)} — ${formatRatio(point.ratio)} over ${point.samples} sample${point.samples === 1 ? "" : "s"}</title></rect>`;
  });

  return html`<figure class="chart chart-sampled">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated availability over the selected window" preserveAspectRatio="none">
      ${raw(patterns())} ${raw(unobservedRegion(domain))} ${raw(frame())}
      <text x="${PAD.left - 8}" y="${PAD.top + 4}" text-anchor="end" class="chart-axis">100%</text>
      <text x="${PAD.left - 8}" y="${PAD.top + PLOT_H}" text-anchor="end" class="chart-axis">0%</text>
      ${join(bars)} ${raw(axisDates(domain))}
    </svg>
    <figcaption>
      ${APPROX} Estimated share of probes that were answered, per bucket. Sampled — a fainter bar rests on
      fewer samples.
    </figcaption>
  </figure>`;
}

// ── latency: SAMPLED ──────────────────────────────────────────────────────

/** Dashed, because it is an estimate. p95 is fainter and dashed more loosely. */
export function latencyChart(points: readonly LatencyPoint[], domain: Domain): string {
  const usable = points.filter((p) => p.p50_ms !== null);
  if (usable.length === 0) return "";

  const all = points.flatMap((p) => [p.p50_ms, p.p95_ms].filter((v): v is number => v !== null));
  const max = Math.max(...all, 1);
  const top = max * 1.2;

  const y = (value: number): number => PAD.top + PLOT_H - (value / top) * PLOT_H;

  const path = (key: "p50_ms" | "p95_ms"): string => {
    const usablePoints = points.filter((p) => p[key] !== null);
    if (usablePoints.length === 0) return "";
    const d = usablePoints
      .map((p, i) => `${i === 0 ? "M" : "L"} ${round(x(Date.parse(p.t), domain))} ${round(y(p[key] as number))}`)
      .join(" ");
    return html`<path d="${d}" class="${key === "p50_ms" ? "chart-line-sampled" : "chart-line-sampled-faint"}" />`;
  };

  const dots = usable.map(
    (point) =>
      html`<circle
        cx="${round(x(Date.parse(point.t), domain))}"
        cy="${round(y(point.p50_ms as number))}"
        r="3"
        class="chart-dot-sampled"
      ><title>${formatDate(point.t)} — ${APPROX}${point.p50_ms} ms median over ${point.samples} sample${point.samples === 1 ? "" : "s"}</title></circle>`,
  );

  return html`<figure class="chart chart-sampled">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Estimated response latency over the selected window" preserveAspectRatio="none">
      ${raw(patterns())} ${raw(unobservedRegion(domain))} ${raw(frame())}
      <text x="${PAD.left - 8}" y="${PAD.top + 4}" text-anchor="end" class="chart-axis">${Math.round(top)} ms</text>
      <text x="${PAD.left - 8}" y="${PAD.top + PLOT_H}" text-anchor="end" class="chart-axis">0</text>
      ${raw(path("p95_ms"))} ${raw(path("p50_ms"))} ${join(dots)} ${raw(axisDates(domain))}
    </svg>
    <figcaption>
      ${APPROX} Estimated median (solid dashes) and 95th percentile (faint) response time of successful
      probes. Sampled.
    </figcaption>
  </figure>`;
}
