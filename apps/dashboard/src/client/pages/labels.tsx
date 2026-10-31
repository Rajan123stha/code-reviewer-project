import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Badge, Card, Empty, ErrorBox, Icon, PageHead, type Tone } from '../components.js';
import { count, humanize, percent } from '../format.js';
import { href, navigate, useApi } from '../lib.js';

// --- Shared ---------------------------------------------------------------------------------

interface CaseList {
  guide: Record<string, string>;
  total: number;
  counts: { valid: number; invalid: number; unsure: number };
  items: { id: string; repo: string; verdict: string | null }[];
}

interface CaseDetail {
  id: string;
  repo: string;
  index: number;
  total: number;
  daysToFix: number;
  blameShare: number;
  fix: { sha: string; date: string; subject: string; diff: string };
  introduced: { sha: string; date: string; subject: string };
  truth: { path: string; lines: { n: number | null; text: string; truth: boolean }[] }[];
  previous: { verdict: string; note: string; labeler: string } | null;
}

interface CommentSet {
  name: string;
  hash: string;
  total: number;
  labeled: number;
}

interface CommentItem {
  id: string;
  path: string;
  diff: string;
  line: number;
  category: string;
  severity: string;
  claim: string;
  evidence: string;
  suggested_fix: string | null;
  verdict: string | null;
}

const VERDICT_TONE: Record<string, Tone> = {
  valid: 'good',
  nitpick: 'warning',
  invalid: 'critical',
  unsure: 'neutral',
};

const LABELER_KEY = 'reviewlens.labeler';

function useLabeler(): [string, (name: string) => void] {
  const [name, setName] = useState(() => {
    try {
      return window.localStorage.getItem(LABELER_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const save = useCallback((value: string) => {
    setName(value);
    try {
      window.localStorage.setItem(LABELER_KEY, value);
    } catch {
      // Storage blocked: the name lasts for this page only.
    }
  }, []);
  return [name, save];
}

async function postVerdict(url: string, body: { verdict: string; note: string; labeler: string }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `${response.status}`);
  }
}

/** Unified diff with added and removed lines told apart by a sign column and a tint. */
export function DiffView({ diff, highlight }: { diff: string; highlight?: number }) {
  let newLine = 0;
  return (
    <pre className="code diff">
      {diff.split('\n').map((line, i) => {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
        let cls = '';
        let current: number | null = null;
        if (hunk) {
          newLine = Number(hunk[1]);
          cls = 'hunk';
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          cls = 'add';
          current = newLine++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          cls = 'del';
        } else if (line.startsWith(' ')) {
          current = newLine++;
        } else if (/^(diff|index|---|\+\+\+)/.test(line)) {
          cls = 'meta';
        }
        if (current !== null && current === highlight) cls += ' target';
        return (
          <span key={i} className={`diff-line ${cls}`}>
            {line || ' '}
            {'\n'}
          </span>
        );
      })}
    </pre>
  );
}

/** Verdict buttons with number-key shortcuts (ignored while typing in a field). */
function VerdictBar(props: {
  verdicts: readonly string[];
  guide: Record<string, string>;
  current: string | null;
  disabled: boolean;
  onVerdict: (verdict: string) => void;
}) {
  const { verdicts, onVerdict, disabled } = props;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (disabled || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const index = Number(e.key) - 1;
      if (index >= 0 && index < verdicts.length) onVerdict(verdicts[index]!);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [verdicts, onVerdict, disabled]);
  return (
    <div className="verdicts">
      {verdicts.map((v, i) => (
        <button
          key={v}
          type="button"
          className={`button verdict${props.current === v ? ' chosen' : ''}`}
          disabled={disabled}
          onClick={() => onVerdict(v)}
          title={props.guide[v]}
        >
          <kbd>{i + 1}</kbd> {humanize(v)}
        </button>
      ))}
    </div>
  );
}

function LabelerField({ name, onChange }: { name: string; onChange: (v: string) => void }) {
  return (
    <label className="row cell-sub">
      Labeler
      <input
        className="input small"
        value={name}
        placeholder="your name"
        onChange={(e) => onChange(e.target.value)}
        aria-label="Labeler name"
      />
    </label>
  );
}

function Progress({ done, total }: { done: number; total: number }) {
  return (
    <div className="row" style={{ gap: 10 }}>
      <span className="scorebar-track" style={{ width: 140 }} aria-hidden="true">
        <span
          className="scorebar-fill"
          style={{ width: `${total ? (100 * done) / total : 0}%`, display: 'block' }}
        />
      </span>
      <span className="cell-sub num">
        {count(done)} of {count(total)} labeled
      </span>
    </div>
  );
}

// --- Index ----------------------------------------------------------------------------------

export function LabelsPage() {
  const cases = useApi<CaseList>('/api/labels/benchmark');
  const sets = useApi<CommentSet[]>('/api/labels/comments');
  if (cases.error?.startsWith('not found')) {
    return (
      <Card>
        <Empty title="Labeling is off">
          Start the dashboard with `pnpm label` to label on this machine.
        </Empty>
      </Card>
    );
  }
  const c = cases.data;
  const labeled = c ? c.counts.valid + c.counts.invalid + c.counts.unsure : 0;
  const decided = c ? c.counts.valid + c.counts.invalid : 0;
  const nextCase = c?.items.find((i) => i.verdict === null) ?? c?.items[0];
  return (
    <div className="stack">
      <PageHead
        title="Labeling"
        description="Human labels the report depends on. They are written to the same files as the terminal tools, so commit them with the results."
      />
      {cases.error && <ErrorBox error={cases.error} retry={cases.reload} />}
      <div className="grid two">
        <Card title="Benchmark validation" sub="Is each sampled case a real, catchable bug?">
          {c ? (
            <div className="stack" style={{ gap: 14 }}>
              <Progress done={labeled} total={c.total} />
              <p className="secondary" style={{ margin: 0 }}>
                Label-noise rate so far:{' '}
                <strong>{decided ? percent(c.counts.invalid / decided, 1) : '—'}</strong>{' '}
                <span className="cell-sub">
                  ({c.counts.invalid} invalid, {c.counts.valid} valid, {c.counts.unsure} unsure)
                </span>
              </p>
              {nextCase && (
                <div>
                  <a className="button" href={href(`labels/benchmark/${nextCase.id}`)}>
                    {labeled === 0
                      ? 'Start labeling'
                      : labeled < c.total
                        ? 'Continue'
                        : 'Review labels'}
                  </a>
                </div>
              )}
            </div>
          ) : (
            <Empty title="Loading…" />
          )}
        </Card>
        <Card title="Comment precision" sub="Are the comments the reviewer posted any good?">
          {!sets.data ? (
            <Empty title="Loading…" />
          ) : sets.data.length === 0 ? (
            <Empty title="No sampled comments">
              Sample some with `python -m rlharness.cli comments &lt;experiment.yaml&gt;`.
            </Empty>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {sets.data.map((s) => (
                <div key={`${s.name}/${s.hash}`} className="row">
                  <a href={href(`labels/comments/${s.name}/${s.hash}`)} className="cell-title">
                    {s.name}
                  </a>
                  <span className="chip mono">{s.hash}</span>
                  <span className="spacer" />
                  <Progress done={s.labeled} total={s.total} />
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// --- Benchmark case labeling --------------------------------------------------------------

export function CaseLabelPage({ id }: { id: string }) {
  const list = useApi<CaseList>('/api/labels/benchmark');
  const detail = useApi<CaseDetail>(`/api/labels/benchmark/${encodeURIComponent(id)}`);
  const [labeler, setLabeler] = useLabeler();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setNote(detail.data?.previous?.note ?? '');
    setError(undefined);
  }, [detail.data?.id, detail.data?.previous?.note]);

  const items = list.data?.items ?? [];
  const position = items.findIndex((i) => i.id === id);
  const go = (offset: number) => {
    const next = items[position + offset];
    if (next) navigate(href(`labels/benchmark/${next.id}`));
  };
  const nextUnlabeled = () => {
    const after = [...items.slice(position + 1), ...items.slice(0, position)];
    return after.find((i) => i.verdict === null);
  };

  const submit = useCallback(
    async (verdict: string) => {
      if (!labeler.trim()) {
        setError('Enter your name first, so labels from different people can be compared.');
        return;
      }
      setSaving(true);
      try {
        await postVerdict(`/api/labels/benchmark/${encodeURIComponent(id)}`, {
          verdict,
          note,
          labeler,
        });
        const next = nextUnlabeled();
        list.reload();
        if (next) navigate(href(`labels/benchmark/${next.id}`));
        else navigate(href('labels'));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [id, labeler, note, items],
  );

  if (detail.error) return <ErrorBox error={detail.error} retry={detail.reload} />;
  const d = detail.data;
  if (!d) return <Empty title="Loading…" />;
  return (
    <div className="stack">
      <PageHead
        crumbs={<a href={href('labels')}>Labeling</a>}
        title={`Case ${d.index + 1} of ${d.total}`}
        description={
          <span className="row">
            <span>{d.repo}</span>
            <span className="cell-sub">
              fixed {Math.round(d.daysToFix)} days later · blame share {percent(d.blameShare)}
            </span>
            {d.previous && (
              <Badge tone={VERDICT_TONE[d.previous.verdict] ?? 'neutral'}>
                labeled {d.previous.verdict} by {d.previous.labeler}
              </Badge>
            )}
          </span>
        }
        actions={<LabelerField name={labeler} onChange={setLabeler} />}
      />
      <Card title="The question">
        <dl className="guide">
          {Object.entries(list.data?.guide ?? {}).map(([k, v]) => (
            <div key={k}>
              <dt>{humanize(k)}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card
        title="Introducing change"
        sub={`${d.introduced.sha.slice(0, 10)} · ${d.introduced.date.slice(0, 10)}`}
      >
        <p className="secondary" style={{ marginTop: 0 }}>
          {d.introduced.subject}
        </p>
        <p className="cell-sub">Marked lines were later removed or rewritten by the fix.</p>
        {d.truth.map((t) => (
          <div key={t.path} style={{ marginTop: 10 }}>
            <div className="mono cell-sub">{t.path}</div>
            {t.lines.length === 0 ? (
              <p className="cell-sub">Cannot read this file at the introducing commit.</p>
            ) : (
              <pre className="code diff">
                {t.lines.map((l, i) => (
                  <span
                    key={i}
                    className={`diff-line${l.truth ? ' target' : l.n === null ? ' meta' : ''}`}
                  >
                    {l.n === null
                      ? '      …'
                      : `${l.truth ? '>>' : '  '} ${String(l.n).padStart(5)} | ${l.text}`}
                    {'\n'}
                  </span>
                ))}
              </pre>
            )}
          </div>
        ))}
      </Card>
      <Card title="The later fix" sub={`${d.fix.sha.slice(0, 10)} · ${d.fix.date.slice(0, 10)}`}>
        <p className="secondary" style={{ marginTop: 0 }}>
          {d.fix.subject}
        </p>
        <DiffView diff={d.fix.diff} />
      </Card>
      <LabelFooter
        error={error}
        note={note}
        onNote={setNote}
        bar={
          <VerdictBar
            verdicts={['valid', 'invalid', 'unsure']}
            guide={list.data?.guide ?? {}}
            current={d.previous?.verdict ?? null}
            disabled={saving}
            onVerdict={(v) => void submit(v)}
          />
        }
        onPrev={position > 0 ? () => go(-1) : undefined}
        onNext={position >= 0 && position < items.length - 1 ? () => go(1) : undefined}
      />
    </div>
  );
}

function LabelFooter(props: {
  bar: ReactNode;
  note: string;
  onNote: (v: string) => void;
  error: string | undefined;
  onPrev: (() => void) | undefined;
  onNext: (() => void) | undefined;
}) {
  return (
    <div className="label-footer card">
      <div className="row" style={{ gap: 12 }}>
        <button className="button" type="button" disabled={!props.onPrev} onClick={props.onPrev}>
          <Icon name="back" size={14} /> Previous
        </button>
        {props.bar}
        <input
          className="input"
          style={{ flex: 1 }}
          placeholder="Note (optional)"
          aria-label="Note"
          value={props.note}
          onChange={(e) => props.onNote(e.target.value)}
        />
        <button className="button" type="button" disabled={!props.onNext} onClick={props.onNext}>
          Skip
        </button>
      </div>
      {props.error && (
        <div
          className="cell-sub"
          role="alert"
          style={{ color: 'var(--critical-ink)', marginTop: 8 }}
        >
          {props.error}
        </div>
      )}
    </div>
  );
}

// --- Comment labeling -----------------------------------------------------------------------

export function CommentLabelPage({ name, hash, id }: { name: string; hash: string; id?: string }) {
  const base = `/api/labels/comments/${encodeURIComponent(name)}/${encodeURIComponent(hash)}`;
  const set = useApi<{ guide: Record<string, string>; items: CommentItem[] }>(base);
  const [labeler, setLabeler] = useLabeler();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const items = set.data?.items ?? [];
  const position = Math.max(
    0,
    id ? items.findIndex((i) => i.id === id) : items.findIndex((i) => i.verdict === null),
  );
  const item = items[position];
  const route = (i: CommentItem) => href(`labels/comments/${name}/${hash}/${i.id}`);
  useEffect(() => {
    setNote('');
    setError(undefined);
  }, [item?.id]);

  const submit = useCallback(
    async (verdict: string) => {
      if (!item) return;
      if (!labeler.trim()) {
        setError('Enter your name first, so labels from different people can be compared.');
        return;
      }
      setSaving(true);
      try {
        await postVerdict(`${base}/${encodeURIComponent(item.id)}`, { verdict, note, labeler });
        const after = [...items.slice(position + 1), ...items.slice(0, position)];
        const next = after.find((i) => i.verdict === null);
        set.reload();
        navigate(next ? route(next) : href('labels'));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [item?.id, labeler, note, items],
  );

  if (set.error) return <ErrorBox error={set.error} retry={set.reload} />;
  if (!set.data) return <Empty title="Loading…" />;
  if (!item) return <Empty title="No comments in this sample" />;
  const done = items.filter((i) => i.verdict !== null).length;
  return (
    <div className="stack">
      <PageHead
        crumbs={<a href={href('labels')}>Labeling</a>}
        title={`${name}: comment ${position + 1} of ${items.length}`}
        description={
          <span className="row">
            <Progress done={done} total={items.length} />
            <span className="cell-sub">The strategy that wrote each comment is hidden.</span>
          </span>
        }
        actions={<LabelerField name={labeler} onChange={setLabeler} />}
      />
      <Card title="The question">
        <dl className="guide">
          {Object.entries(set.data.guide).map(([k, v]) => (
            <div key={k}>
              <dt>{humanize(k)}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card
        title={
          <span className="mono">
            {item.path}:{item.line}
          </span>
        }
        sub={`${humanize(item.severity)} · ${humanize(item.category)}`}
      >
        <p style={{ marginTop: 0 }}>{item.claim}</p>
        <pre className="code">{item.evidence}</pre>
        {item.suggested_fix && (
          <p className="secondary">
            <strong>Suggested fix:</strong> {item.suggested_fix}
          </p>
        )}
        {item.verdict && (
          <Badge tone={VERDICT_TONE[item.verdict] ?? 'neutral'}>labeled {item.verdict}</Badge>
        )}
      </Card>
      <Card title="Diff of the commented file" sub={`line ${item.line} highlighted`}>
        <DiffView diff={item.diff} highlight={item.line} />
      </Card>
      <LabelFooter
        error={error}
        note={note}
        onNote={setNote}
        bar={
          <VerdictBar
            verdicts={['valid', 'nitpick', 'invalid']}
            guide={set.data.guide}
            current={item.verdict}
            disabled={saving}
            onVerdict={(v) => void submit(v)}
          />
        }
        onPrev={position > 0 ? () => navigate(route(items[position - 1]!)) : undefined}
        onNext={
          position < items.length - 1 ? () => navigate(route(items[position + 1]!)) : undefined
        }
      />
    </div>
  );
}
