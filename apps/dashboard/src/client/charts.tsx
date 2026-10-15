import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ToneMark, type Tone } from './components.js';
import { count } from './format.js';
import { labelIndices, niceTicks } from './scale.js';

// Charts follow fixed mark specs: columns at most 24px wide with a 4px rounded data end,
// hairline gridlines, one axis, text in ink tokens (never the series color), a hover or
// focus tooltip on every mark, and a table view for every chart.

/** Width of the chart's box in CSS pixels, so the SVG is drawn 1:1 and its text never scales. */
function useWidth(fallback = 640) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.max(240, Math.round(el.getBoundingClientRect().width)));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

interface TooltipState {
  x: number;
  y: number;
  value: string;
  label: string;
}

function Tooltip({ tip }: { tip: TooltipState | null }) {
  if (!tip) return null;
  return (
    <div className="tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      <div className="tt-value">{tip.value}</div>
      <div className="tt-label">{tip.label}</div>
    </div>
  );
}

/** Column path with a 4px rounded top and a square base. */
function columnPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

export interface ColumnDatum {
  key: string;
  label: string;
  value: number;
  /** Extra line in the tooltip. */
  detail?: string;
}

/** Single-series column chart (counts over time). The title names the series; no legend. */
export function ColumnChart(props: {
  data: ColumnDatum[];
  height?: number;
  valueLabel: (value: number) => string;
  ariaLabel: string;
}) {
  const { data } = props;
  const [box, width] = useWidth();
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const height = props.height ?? 180;
  const pad = { top: 8, right: 4, bottom: 26, left: 32 };
  const ticks = niceTicks(Math.max(...data.map((d) => d.value), 0));
  const top = ticks[ticks.length - 1]!;
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const band = plotW / Math.max(data.length, 1);
  // Columns take at most 70% of their band (and 24px), leaving air between them.
  const barW = Math.min(24, Math.max(2, band * 0.7));
  const y = (v: number) => pad.top + plotH - (v / top) * plotH;
  const labels = new Set(labelIndices(data.length, Math.max(2, Math.floor(plotW / 72))));

  const show = (i: number, target: SVGElement) => {
    const svg = target.ownerSVGElement ?? (target as SVGSVGElement);
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const d = data[i]!;
    setActive(i);
    setTip({
      x: (pad.left + band * i + band / 2) * scale,
      y: y(d.value) * scale,
      value: props.valueLabel(d.value),
      label: d.detail ? `${d.label} · ${d.detail}` : d.label,
    });
  };
  const hide = () => {
    setActive(null);
    setTip(null);
  };

  return (
    <div className="chart" ref={box}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={t === 0 ? 'baseline' : 'grid-line'}
              x1={pad.left}
              x2={width - pad.right}
              y1={y(t)}
              y2={y(t)}
            />
            <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="num">
              {count(t)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = pad.left + band * i + (band - barW) / 2;
          const h = Math.max(0, y(0) - y(d.value));
          return (
            <g key={d.key}>
              <rect
                className="hit"
                x={pad.left + band * i}
                y={pad.top}
                width={band}
                height={plotH}
                tabIndex={0}
                aria-label={`${d.label}: ${props.valueLabel(d.value)}`}
                onPointerEnter={(e) => show(i, e.currentTarget)}
                onPointerLeave={hide}
                onFocus={(e) => show(i, e.currentTarget)}
                onBlur={hide}
              />
              {h > 0 && (
                <path
                  className={`mark${active === i ? ' active' : ''}`}
                  d={columnPath(x, y(d.value), barW, h)}
                  pointerEvents="none"
                />
              )}
              {labels.has(i) && (
                <text x={pad.left + band * i + band / 2} y={height - 6} textAnchor="middle">
                  {d.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

export interface BarDatum {
  key: string;
  label: ReactNode;
  /** 0..1 of the track. */
  share: number;
  value: ReactNode;
  /** Optional status mark beside the label (for states). */
  tone?: Tone;
  /** Color the bar by its tone instead of the series color. */
  colorByTone?: boolean;
  title?: string;
}

/** Horizontal bars with labels on the left and the value at the tip. */
export function BarList({ data }: { data: BarDatum[] }) {
  const toneColor: Record<Tone, string> = {
    good: 'var(--good)',
    warning: 'var(--warning)',
    serious: 'var(--serious)',
    critical: 'var(--critical)',
    neutral: 'var(--neutral)',
    info: 'var(--accent)',
  };
  return (
    <div className="bars">
      {data.map((d) => (
        <div className="bar-row" key={d.key} title={d.title}>
          <div className="bar-label">
            {d.tone && <ToneMark tone={d.tone} />}
            <span>{d.label}</span>
          </div>
          <div className="bar-track">
            <div
              className="bar-fill"
              style={{
                width: `${Math.max(0, Math.min(1, d.share)) * 100}%`,
                ...(d.colorByTone && d.tone ? { background: toneColor[d.tone] } : {}),
              }}
            />
          </div>
          <div className="bar-value">{d.value}</div>
        </div>
      ))}
    </div>
  );
}

export interface IntervalDatum {
  key: string;
  label: string;
  value: number;
  low: number;
  high: number;
}

/** Point estimates with 95% intervals on a shared 0..max axis (one series). */
export function IntervalChart(props: {
  data: IntervalDatum[];
  format: (value: number) => string;
  ariaLabel: string;
}) {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const [box, width] = useWidth();
  const rowH = 34;
  const pad = { top: 6, right: 16, bottom: 24, left: 120 };
  const height = pad.top + pad.bottom + rowH * props.data.length;
  const ticks = niceTicks(Math.max(...props.data.map((d) => d.high), 0.05));
  const top = ticks[ticks.length - 1]!;
  const plotW = width - pad.left - pad.right;
  const x = (v: number) => pad.left + (v / top) * plotW;

  return (
    <div className="chart" ref={box}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={props.ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line
              className={t === 0 ? 'baseline' : 'grid-line'}
              x1={x(t)}
              x2={x(t)}
              y1={pad.top}
              y2={height - pad.bottom}
            />
            <text x={x(t)} y={height - 6} textAnchor="middle" className="num">
              {props.format(t)}
            </text>
          </g>
        ))}
        {props.data.map((d, i) => {
          const cy = pad.top + rowH * i + rowH / 2;
          const show = (target: SVGElement) => {
            const rect = (
              target.ownerSVGElement ?? (target as SVGSVGElement)
            ).getBoundingClientRect();
            const scale = rect.width / width;
            setTip({
              x: x(d.value) * scale,
              y: (cy - 6) * scale,
              value: props.format(d.value),
              label: `${d.label} · 95% CI ${props.format(d.low)} to ${props.format(d.high)}`,
            });
          };
          return (
            <g key={d.key}>
              <text
                x={pad.left - 12}
                y={cy}
                dy="0.32em"
                textAnchor="end"
                style={{ fill: 'var(--ink-2)' }}
              >
                {d.label}
              </text>
              <line className="whisker" x1={x(d.low)} x2={x(d.high)} y1={cy} y2={cy} />
              <line className="whisker" x1={x(d.low)} x2={x(d.low)} y1={cy - 5} y2={cy + 5} />
              <line className="whisker" x1={x(d.high)} x2={x(d.high)} y1={cy - 5} y2={cy + 5} />
              <circle className="dot" cx={x(d.value)} cy={cy} r={5} />
              <rect
                className="hit"
                x={pad.left}
                y={cy - rowH / 2}
                width={plotW}
                height={rowH}
                tabIndex={0}
                aria-label={`${d.label}: ${props.format(d.value)}, 95% interval ${props.format(d.low)} to ${props.format(d.high)}`}
                onPointerEnter={(e) => show(e.currentTarget)}
                onPointerLeave={() => setTip(null)}
                onFocus={(e) => show(e.currentTarget)}
                onBlur={() => setTip(null)}
              />
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** A chart's data as a table, behind a disclosure, so no value depends on hovering. */
export function TableView(props: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <details style={{ marginTop: 12 }}>
      <summary>Show as table</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {props.headers.map((h, i) => (
                <th key={h} className={i > 0 ? 'r' : undefined}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} className={c > 0 ? 'r num' : undefined}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
