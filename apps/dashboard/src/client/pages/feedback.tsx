import type { FeedbackSummary, GroupAcceptance } from '@reviewlens/db/dashboard-types';
import { BarList, TableView } from '../charts.js';
import { Badge, Card, Empty, ErrorBox, OUTCOME, PageHead } from '../components.js';
import { count, humanize, percent, ratio, relativeTime } from '../format.js';
import { href, useApi } from '../lib.js';

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];

function AcceptanceBars({ groups, order }: { groups: GroupAcceptance[]; order?: string[] }) {
  const labeled = groups.filter((g) => g.labeled > 0);
  if (labeled.length === 0) return <Empty title="No labeled comments yet" />;
  const sorted = order
    ? [...labeled].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
    : [...labeled].sort((a, b) => b.useful / b.labeled - a.useful / a.labeled);
  return (
    <>
      <BarList
        data={sorted.map((g) => ({
          key: g.key,
          label: humanize(g.key),
          share: g.useful / g.labeled,
          value: (
            <>
              {ratio(g.useful, g.labeled)} <span className="muted">n={count(g.labeled)}</span>
            </>
          ),
          title: `${g.useful} useful of ${g.labeled} with an outcome (${g.posted} posted)`,
        }))}
      />
      <TableView
        headers={['Group', 'Posted', 'With outcome', 'Useful', 'Useful share']}
        rows={sorted.map((g) => [
          humanize(g.key),
          count(g.posted),
          count(g.labeled),
          count(g.useful),
          percent(g.useful / g.labeled),
        ])}
      />
    </>
  );
}

export function FeedbackPage() {
  const feedback = useApi<FeedbackSummary>('/api/feedback');
  if (feedback.error) return <ErrorBox error={feedback.error} retry={feedback.reload} />;
  const f = feedback.data;
  return (
    <div className="stack">
      <PageHead
        title="Feedback"
        description="Which kinds of comments authors act on. These labels also train the learned filter."
      />
      <div className="banner">
        <span>
          <strong>How a comment is labeled.</strong> Thumbs down counts as not useful, then thumbs
          up as useful, then changed lines within 3 of the comment as useful; dismissed or ignored
          counts as not useful. Changed lines can be a coincidence, and ignored comments may still
          be right, so treat these shares as noisy.
        </span>
      </div>
      <div className="grid two">
        <Card title="Useful share by category">
          {f ? <AcceptanceBars groups={f.byCategory} /> : <Empty title="Loading…" />}
        </Card>
        <Card title="Useful share by severity">
          {f ? (
            <AcceptanceBars groups={f.bySeverity} order={SEVERITY_ORDER} />
          ) : (
            <Empty title="Loading…" />
          )}
        </Card>
      </div>
      <Card title="Latest outcomes" flush>
        {!f ? (
          <Empty title="Loading…" />
        ) : f.recent.length === 0 ? (
          <Empty title="No feedback recorded yet" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Outcome</th>
                  <th>Comment</th>
                  <th>Where</th>
                  <th className="r">Observed</th>
                </tr>
              </thead>
              <tbody>
                {f.recent.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Badge tone={OUTCOME[e.outcome]?.tone ?? 'neutral'}>
                        {OUTCOME[e.outcome]?.label ?? e.outcome}
                      </Badge>
                      <div className="cell-sub">via {e.source}</div>
                    </td>
                    <td style={{ maxWidth: 420 }}>
                      {e.claim}
                      <div className="cell-sub">{humanize(e.category)}</div>
                    </td>
                    <td>
                      <a href={href(`reviews/${e.reviewId}`)}>
                        {e.repository} #{e.pullNumber}
                      </a>
                      <div className="cell-sub mono">
                        {e.file}:{e.line}
                      </div>
                    </td>
                    <td className="r muted">{relativeTime(e.observedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
