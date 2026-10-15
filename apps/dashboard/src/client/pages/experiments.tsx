import { IntervalChart, TableView } from '../charts.js';
import { Card, Empty, ErrorBox, Icon, PageHead } from '../components.js';
import { count, dateTime, duration, percent, usd } from '../format.js';
import { href, useApi } from '../lib.js';

// The harness's summary.json (eval/harness/src/rlharness/report.py). Read-only here.
interface Metric {
  mean: number;
  ci95: [number, number];
  run_sd: number | null;
  per_run: number[];
}
interface ArmSummary {
  arm: string;
  strategy: string;
  cases: number;
  runs: number;
  reviews_failed: number;
  reviews_missing: number;
  recall_at: Record<string, Metric>;
  file_recall_at_max_k: number;
  localization_accuracy: number | null;
  comments_per_review: number;
  ground_truth_precision: number | null;
  tokens_in: number;
  cost_usd_per_review: number | null;
  latency_s_p50: number | null;
}
interface Comparison {
  arm: string;
  baseline: string;
  k: number;
  cases: number;
  recall_diff: number;
  ci95: [number, number];
  only_arm: number;
  only_baseline: number;
  mcnemar_p: number | null;
}
interface ExperimentSummary {
  experiment: string;
  description: string;
  spec_hash: string;
  scored_at: string;
  line_tolerance: number;
  k: number[];
  runs: number;
  inputs_selected: number;
  cases_complete_in_all_arms: number;
  baseline: string;
  arms: ArmSummary[];
  comparisons: Comparison[];
}
interface ExperimentEntry {
  name: string;
  hash: string;
  description: string;
  scoredAt: string | null;
  arms: string[];
  cases: number;
  runs: number;
}

/** Below this many cases, intervals are too wide to rank strategies. */
const SMALL_SAMPLE = 30;

export function ExperimentsPage() {
  const list = useApi<ExperimentEntry[]>('/api/experiments');
  if (list.error) return <ErrorBox error={list.error} retry={list.reload} />;
  return (
    <div className="stack">
      <PageHead
        title="Experiments"
        description="Ablations scored by the eval harness on Benchmark A. Numbers are read from eval/results; nothing here is computed in the browser."
      />
      {!list.data ? (
        <Card>
          <Empty title="Loading…" />
        </Card>
      ) : list.data.length === 0 ? (
        <Card>
          <Empty title="No scored experiments">
            Run one with <code>make eval EXPERIMENT=E1-strategies</code>; it appears here once
            scored.
          </Empty>
        </Card>
      ) : (
        <div className="grid two">
          {list.data.map((e) => (
            <a
              key={`${e.name}/${e.hash}`}
              href={href(`experiments/${e.name}/${e.hash}`)}
              className="card tile"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              <div className="row">
                <h2>{e.name}</h2>
                <span className="chip mono">{e.hash}</span>
                <span className="spacer" />
                <span className="muted">
                  <Icon name="experiments" size={15} />
                </span>
              </div>
              <p className="secondary" style={{ margin: '6px 0 10px' }}>
                {e.description}
              </p>
              <div className="row cell-sub">
                <span>{e.arms.join(' · ')}</span>
                <span>·</span>
                <span>
                  {count(e.cases)} cases × {e.runs} run{e.runs === 1 ? '' : 's'}
                </span>
                <span>·</span>
                <span>scored {dateTime(e.scoredAt)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExperimentDetailPage({ name, hash }: { name: string; hash: string }) {
  const res = useApi<ExperimentSummary>(
    `/api/experiments/${encodeURIComponent(name)}/${encodeURIComponent(hash)}`,
  );
  if (res.error) return <ErrorBox error={res.error} retry={res.reload} />;
  const s = res.data;
  if (!s) return <Empty title="Loading…" />;
  const kMax = String(Math.max(...s.k));
  const small = s.cases_complete_in_all_arms < SMALL_SAMPLE;

  return (
    <div className="stack">
      <PageHead
        crumbs={<a href={href('experiments')}>Experiments</a>}
        title={s.experiment}
        description={s.description}
        actions={
          <div className="cell-sub" style={{ textAlign: 'right' }}>
            spec <span className="mono">{s.spec_hash}</span>
            <br />
            scored {dateTime(s.scored_at)}
          </div>
        }
      />
      {small && (
        <div className="banner warn" role="note">
          <span>
            <strong>Small sample.</strong> {count(s.cases_complete_in_all_arms)} cases: the 95%
            intervals overlap widely, so these numbers show that the harness ran, not which strategy
            is better.
          </span>
        </div>
      )}
      <div className="grid tiles">
        <div className="card tile">
          <div className="tile-label">Cases scored</div>
          <div className="tile-value">{count(s.cases_complete_in_all_arms)}</div>
          <div className="tile-hint">{count(s.inputs_selected)} changes reviewed</div>
        </div>
        <div className="card tile">
          <div className="tile-label">Arms × runs</div>
          <div className="tile-value">
            {s.arms.length} × {s.runs}
          </div>
          <div className="tile-hint">baseline {s.baseline}</div>
        </div>
        <div className="card tile">
          <div className="tile-label">Hit rule</div>
          <div className="tile-value">±{s.line_tolerance} lines</div>
          <div className="tile-hint">of a line the later fix changed</div>
        </div>
      </div>

      <Card
        title={`Bug-catch recall@${kMax}`}
        sub="Point estimate and 95% bootstrap interval over cases"
      >
        <IntervalChart
          ariaLabel={`Recall at ${kMax} per arm with 95% intervals`}
          format={(v) => percent(v)}
          data={s.arms.map((a) => {
            const m = a.recall_at[kMax]!;
            return { key: a.arm, label: a.arm, value: m.mean, low: m.ci95[0], high: m.ci95[1] };
          })}
        />
        <TableView
          headers={['Arm', `Recall@${kMax}`, 'CI low', 'CI high', 'Run SD']}
          rows={s.arms.map((a) => {
            const m = a.recall_at[kMax]!;
            return [
              a.arm,
              percent(m.mean, 1),
              percent(m.ci95[0], 1),
              percent(m.ci95[1], 1),
              m.run_sd === null ? '—' : percent(m.run_sd, 1),
            ];
          })}
        />
      </Card>

      <Card title="All metrics" flush>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Arm</th>
                {s.k.map((k) => (
                  <th key={k} className="r">
                    R@{k}
                  </th>
                ))}
                <th className="r">File recall</th>
                <th className="r">Localization</th>
                <th className="r">Comments / review</th>
                <th className="r">GT precision</th>
                <th className="r">Tokens in</th>
                <th className="r">p50 time</th>
                <th className="r">Cost / review</th>
              </tr>
            </thead>
            <tbody>
              {s.arms.map((a) => (
                <tr key={a.arm}>
                  <td>
                    <span className="cell-title">{a.arm}</span>
                    {a.arm === s.baseline && (
                      <span className="chip" style={{ marginLeft: 6 }}>
                        baseline
                      </span>
                    )}
                    {(a.reviews_failed > 0 || a.reviews_missing > 0) && (
                      <div className="cell-sub">
                        {a.reviews_failed} failed · {a.reviews_missing} missing
                      </div>
                    )}
                  </td>
                  {s.k.map((k) => (
                    <td key={k} className="r num">
                      {percent(a.recall_at[String(k)]?.mean, 1)}
                    </td>
                  ))}
                  <td className="r num">{percent(a.file_recall_at_max_k, 1)}</td>
                  <td className="r num">{percent(a.localization_accuracy, 1)}</td>
                  <td className="r num">{a.comments_per_review.toFixed(2)}</td>
                  <td className="r num">{percent(a.ground_truth_precision, 1)}</td>
                  <td className="r num">{count(Math.round(a.tokens_in))}</td>
                  <td className="r num">
                    {a.latency_s_p50 === null ? '—' : duration(a.latency_s_p50 * 1000)}
                  </td>
                  <td className="r num">{usd(a.cost_usd_per_review)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="cell-sub" style={{ padding: '10px 18px 14px', margin: 0 }}>
          GT precision is a lower bound: comments on real problems the benchmark does not know about
          count against it.
        </p>
      </Card>

      {s.comparisons.length > 0 && (
        <Card title="Paired comparisons with the baseline" sub="Same cases in both arms" flush>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Arm vs baseline</th>
                  <th className="r">Recall difference</th>
                  <th className="r">95% CI</th>
                  <th className="r">Caught only by arm</th>
                  <th className="r">Only by baseline</th>
                  <th className="r">McNemar p</th>
                </tr>
              </thead>
              <tbody>
                {s.comparisons.map((c) => (
                  <tr key={`${c.arm}-${c.k}`}>
                    <td>
                      {c.arm} vs {c.baseline} <span className="cell-sub">@{c.k}</span>
                    </td>
                    <td className="r num">
                      {c.recall_diff > 0 ? '+' : ''}
                      {percent(c.recall_diff, 1)}
                    </td>
                    <td className="r num">
                      {percent(c.ci95[0], 1)} to {percent(c.ci95[1], 1)}
                    </td>
                    <td className="r num">{count(c.only_arm)}</td>
                    <td className="r num">{count(c.only_baseline)}</td>
                    <td className="r num">{c.mcnemar_p === null ? '—' : c.mcnemar_p.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
