import type { OverviewStats, ReviewSummary } from '@reviewlens/db/dashboard-types';
import { BarList, ColumnChart, TableView } from '../charts.js';
import { Card, Empty, ErrorBox, OUTCOME, PageHead, StatTile } from '../components.js';
import { count, duration, percent, ratio, usd } from '../format.js';
import { href, useApi } from '../lib.js';
import { ReviewTable } from './reviews.js';

export function OverviewPage() {
  const stats = useApi<OverviewStats>('/api/overview');
  const recent = useApi<{ items: ReviewSummary[]; total: number }>('/api/reviews?limit=6');

  if (stats.error) return <ErrorBox error={stats.error} retry={stats.reload} />;
  const s = stats.data;
  return (
    <div className={`stack${stats.loading && s ? ' loading' : ''}`}>
      <PageHead
        title="Overview"
        description="What the reviewer did across every installed repository, and what happened to its comments."
      />
      {s && s.reviews.total === 0 ? (
        <Card>
          <Empty title="No reviews yet">
            Reviews appear here once the GitHub App is installed and a pull request is opened or
            updated. Experiment results are under Experiments.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="grid tiles">
            <StatTile
              label="Reviews posted"
              value={s ? count(s.reviews.posted) : '…'}
              hint={
                s ? `${count(s.reviews.total)} run · ${count(s.reviews.failed)} failed` : undefined
              }
            />
            <StatTile
              label="Comments posted"
              value={s ? count(s.comments.posted) : '…'}
              hint={
                s
                  ? `of ${count(s.comments.candidates)} candidates (${ratio(s.comments.posted, s.comments.candidates)})`
                  : undefined
              }
            />
            <StatTile
              label="Useful, from feedback"
              value={s ? ratio(s.feedback.useful, s.feedback.labeled) : '…'}
              hint={
                s
                  ? `${count(s.feedback.useful)} of ${count(s.feedback.labeled)} comments with an outcome`
                  : undefined
              }
            />
            <StatTile
              label="Median review time"
              value={s ? duration(s.latencyMs.p50) : '…'}
              hint={s ? `p95 ${duration(s.latencyMs.p95)}` : undefined}
            />
            <StatTile
              label="LLM cost"
              value={s ? usd(s.costUsd) : '…'}
              hint={s ? `${count(s.tokensIn)} tokens in · ${count(s.tokensOut)} out` : undefined}
            />
          </div>

          <div className="grid two">
            <Card title="Reviews per day" sub="Last 30 days, UTC">
              {s && (
                <>
                  <ColumnChart
                    ariaLabel="Reviews per day over the last 30 days"
                    valueLabel={(v) => `${count(v)} review${v === 1 ? '' : 's'}`}
                    data={s.daily.map((d) => ({
                      key: d.date,
                      label: new Date(`${d.date}T00:00:00Z`).toLocaleDateString('en', {
                        month: 'short',
                        day: 'numeric',
                        timeZone: 'UTC',
                      }),
                      value: d.reviews,
                      detail: `${count(d.comments)} comments posted`,
                    }))}
                  />
                  <TableView
                    headers={['Day', 'Reviews', 'Comments posted']}
                    rows={s.daily.map((d) => [d.date, count(d.reviews), count(d.comments)])}
                  />
                </>
              )}
            </Card>
            <Card
              title="What happened to posted comments"
              sub={
                s
                  ? `${count(Object.values(s.feedback.outcomes).reduce((a, b) => a + b, 0))} observations`
                  : undefined
              }
            >
              {s && <OutcomeBars outcomes={s.feedback.outcomes} />}
              <p className="muted" style={{ margin: '14px 0 0', fontSize: 12.5 }}>
                A comment can collect several outcomes.{' '}
                <a href={href('feedback')}>How outcomes become labels</a>
              </p>
            </Card>
          </div>

          <Card title="Latest reviews" actions={<a href={href('reviews')}>All reviews</a>} flush>
            {recent.data && <ReviewTable items={recent.data.items} compact />}
          </Card>
        </>
      )}
    </div>
  );
}

export function OutcomeBars({ outcomes }: { outcomes: Record<string, number> }) {
  const total = Object.values(outcomes).reduce((a, b) => a + b, 0);
  if (total === 0) {
    return (
      <Empty title="No feedback yet">
        Outcomes are recorded when authors push changes, resolve threads, react, or close the pull
        request.
      </Empty>
    );
  }
  const max = Math.max(...Object.values(outcomes));
  return (
    <BarList
      data={Object.entries(OUTCOME).map(([key, meta]) => ({
        key,
        label: meta.label,
        tone: meta.tone,
        colorByTone: true,
        share: (outcomes[key] ?? 0) / max,
        value: (
          <>
            {count(outcomes[key] ?? 0)}{' '}
            <span className="muted">{percent((outcomes[key] ?? 0) / total)}</span>
          </>
        ),
      }))}
    />
  );
}
