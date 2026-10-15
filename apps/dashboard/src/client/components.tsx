import type { ReactNode } from 'react';
import { count } from './format.js';

// --- Icons (inline, stroke = currentColor) ---------------------------------------------------

const ICONS = {
  overview: 'M3 13h7V3H3v10Zm0 8h7v-6H3v6Zm11 0h7V11h-7v10Zm0-18v6h7V3h-7Z',
  reviews: 'M4 5h16M4 12h16M4 19h10',
  repos: 'M4 4h12l4 4v12H4V4Zm4 6h8m-8 4h8m-8 4h5',
  feedback: 'M4 5h16v11H8l-4 4V5Z',
  experiments: 'M9 3v6L4 19a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 19l-5-10V3M8 3h8',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.7-5.7 1.4-1.4M4.9 19.1l1.4-1.4m0-11.4L4.9 4.9m14.2 14.2-1.4-1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  external: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  back: 'M15 18l-6-6 6-6',
} as const;

export function Icon({ name, size = 16 }: { name: keyof typeof ICONS; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

// --- Surfaces -------------------------------------------------------------------------------

export function Card(props: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${props.className ?? ''}`}>
      {props.title !== undefined && (
        <div className="card-head">
          <h2>{props.title}</h2>
          {props.sub !== undefined && <span className="sub">{props.sub}</span>}
          {props.actions !== undefined && <div className="spacer" />}
          {props.actions}
        </div>
      )}
      <div className={`card-body${props.flush ? ' flush' : ''}`}>{props.children}</div>
    </section>
  );
}

export function StatTile(props: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card tile">
      <div className="tile-label">{props.label}</div>
      <div className="tile-value">{props.value}</div>
      {props.hint !== undefined && <div className="tile-hint">{props.hint}</div>}
    </div>
  );
}

export function PageHead(props: {
  title: ReactNode;
  description?: ReactNode;
  crumbs?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        {props.crumbs !== undefined && <div className="crumbs">{props.crumbs}</div>}
        <h1>{props.title}</h1>
        {props.description !== undefined && <p>{props.description}</p>}
      </div>
      {props.actions}
    </header>
  );
}

export function Empty(props: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{props.title}</h3>
      {props.children !== undefined && <p>{props.children}</p>}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="card error-box row" role="alert">
      <span>Could not load: {error}</span>
      {retry && (
        <button className="button" type="button" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

// --- Status: shape + word + color, never color alone -------------------------------------------

export type Tone = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info';

const TONE_COLOR: Record<Tone, string> = {
  good: 'var(--good)',
  warning: 'var(--warning)',
  serious: 'var(--serious)',
  critical: 'var(--critical)',
  neutral: 'var(--neutral)',
  info: 'var(--accent)',
};

/** Distinct shapes per tone, so the state reads without color. */
export function ToneMark({ tone }: { tone: Tone }) {
  const color = TONE_COLOR[tone];
  const shape =
    tone === 'good' ? (
      <path
        d="M2.5 6.2 5 8.6l4.6-5"
        stroke={color}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
      />
    ) : tone === 'critical' ? (
      <path d="M3 3l6 6M9 3 3 9" stroke={color} strokeWidth={2} strokeLinecap="round" />
    ) : tone === 'warning' || tone === 'serious' ? (
      <path d="M6 1.5 11 10.5H1L6 1.5Z" fill={color} />
    ) : tone === 'info' ? (
      <circle cx={6} cy={6} r={4} fill="none" stroke={color} strokeWidth={2} />
    ) : (
      <circle cx={6} cy={6} r={3.5} fill={color} />
    );
  return (
    <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true">
      {shape}
    </svg>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="badge">
      <ToneMark tone={tone} />
      {children}
    </span>
  );
}

export const REVIEW_STATUS: Record<string, { tone: Tone; label: string }> = {
  posted: { tone: 'good', label: 'Posted' },
  completed: { tone: 'info', label: 'Completed' },
  running: { tone: 'neutral', label: 'Running' },
  failed: { tone: 'critical', label: 'Failed' },
};

export const CANDIDATE_STATUS: Record<string, { tone: Tone; label: string; hint: string }> = {
  selected: { tone: 'good', label: 'Posted', hint: 'Valid, unique and within the comment cap' },
  over_cap: { tone: 'neutral', label: 'Over cap', hint: 'Valid, but ranked below the cap' },
  filtered: {
    tone: 'warning',
    label: 'Filtered',
    hint: 'Scored below the learned filter threshold',
  },
  suppressed: { tone: 'neutral', label: 'Suppressed', hint: 'Excluded by the repository policy' },
  duplicate: {
    tone: 'neutral',
    label: 'Duplicate',
    hint: 'Near-duplicate of a higher-ranked comment',
  },
  invalid: { tone: 'critical', label: 'Rejected', hint: 'Failed validation against the diff' },
};

export const OUTCOME: Record<string, { tone: Tone; label: string }> = {
  resolved_with_change: { tone: 'good', label: 'Resolved with change' },
  thumbs_up: { tone: 'good', label: 'Thumbs up' },
  dismissed: { tone: 'serious', label: 'Dismissed' },
  thumbs_down: { tone: 'critical', label: 'Thumbs down' },
  ignored: { tone: 'neutral', label: 'Ignored' },
};

export function Pager(props: {
  total: number;
  offset: number;
  limit: number;
  onPage: (offset: number) => void;
}) {
  const end = Math.min(props.offset + props.limit, props.total);
  return (
    <div className="pager">
      <span className="num">
        {props.total === 0
          ? 'No results'
          : `${count(props.offset + 1)}–${count(end)} of ${count(props.total)}`}
      </span>
      <div className="row">
        <button
          className="button"
          type="button"
          disabled={props.offset === 0}
          onClick={() => props.onPage(Math.max(0, props.offset - props.limit))}
        >
          Previous
        </button>
        <button
          className="button"
          type="button"
          disabled={end >= props.total}
          onClick={() => props.onPage(props.offset + props.limit)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Text with `backtick` spans shown as code. Never parsed as HTML. */
export function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.length > 2 && part.startsWith('`') && part.endsWith('`') ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** A 0..1 score as a short meter plus its number. */
export function ScoreBar({ value, label }: { value: number | null; label: string }) {
  if (value === null) return <span className="muted">—</span>;
  return (
    <span className="scorebar" title={`${label}: ${value.toFixed(2)}`}>
      <span className="scorebar-track" aria-hidden="true">
        <span
          className="scorebar-fill"
          style={{ width: `${Math.round(value * 100)}%`, display: 'block' }}
        />
      </span>
      <span className="num">{value.toFixed(2)}</span>
    </span>
  );
}
