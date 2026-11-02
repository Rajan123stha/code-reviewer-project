import type { RepositorySummary } from '@reviewlens/db/dashboard-types';
import { Card, Empty, ErrorBox, PageHead, ScoreBar } from '../components.js';
import { count, ratio, relativeTime, usd } from '../format.js';
import { href, navigate, useApi } from '../lib.js';

export function RepositoriesPage() {
  const repos = useApi<RepositorySummary[]>('/api/repositories');
  if (repos.error) return <ErrorBox error={repos.error} retry={repos.reload} />;
  return (
    <div className="stack">
      <PageHead
        title="Repositories"
        description="Each repository the app has reviewed, with how its comments were received."
      />
      <Card flush>
        {!repos.data ? (
          <Empty title="Loading…" />
        ) : repos.data.length === 0 ? (
          <Empty title="No repositories yet">A repository appears after its first review.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th className="r">Reviews</th>
                  <th className="r">Comments posted</th>
                  <th>Useful (from feedback)</th>
                  <th className="r">Cost</th>
                  <th className="r">Last review</th>
                </tr>
              </thead>
              <tbody>
                {repos.data.map((r) => (
                  <tr
                    key={r.id}
                    className="clickable"
                    onClick={() => navigate(href('reviews', { repo: r.id }))}
                  >
                    <td>
                      <a
                        className="cell-title"
                        href={href('reviews', { repo: r.id })}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {r.fullName}
                      </a>
                    </td>
                    <td className="r num">{count(r.reviews)}</td>
                    <td className="r num">{count(r.postedComments)}</td>
                    <td>
                      {r.labeled === 0 ? (
                        <span className="muted">no outcomes yet</span>
                      ) : (
                        <span className="row" style={{ gap: 10 }}>
                          <ScoreBar value={r.useful / r.labeled} label="Useful share" />
                          <span className="cell-sub">
                            {ratio(r.useful, r.labeled)} of {count(r.labeled)}
                          </span>
                        </span>
                      )}
                    </td>
                    <td className="r num">{usd(r.costUsd)}</td>
                    <td className="r muted">{relativeTime(r.lastReviewAt)}</td>
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
