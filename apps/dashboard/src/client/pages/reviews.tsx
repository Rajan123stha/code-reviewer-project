import type { RepositorySummary, ReviewSummary } from '@reviewlens/db/dashboard-types';
import { useEffect, useState } from 'react';
import { Badge, Card, Empty, ErrorBox, PageHead, Pager, REVIEW_STATUS } from '../components.js';
import { count, duration, relativeTime, shortSha, usd } from '../format.js';
import { href, navigate, useApi, useRoute } from '../lib.js';

const LIMIT = 25;

export function ReviewTable({
  items,
  compact = false,
}: {
  items: ReviewSummary[];
  compact?: boolean;
}) {
  if (items.length === 0) return <Empty title="No reviews match" />;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Status</th>
            {!compact && <th className="hide-sm">Strategy</th>}
            <th className="r">Comments</th>
            <th className="r hide-sm">Time</th>
            {!compact && <th className="r hide-sm">Cost</th>}
            <th className="r hide-sm">Started</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const status = REVIEW_STATUS[r.status] ?? { tone: 'neutral' as const, label: r.status };
            return (
              <tr
                key={r.id}
                className="clickable"
                onClick={() => navigate(href(`reviews/${r.id}`))}
              >
                <td>
                  <a
                    className="cell-title"
                    href={href(`reviews/${r.id}`)}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {r.pullTitle}
                  </a>
                  <div className="cell-sub">
                    {r.repository} #{r.pullNumber} ·{' '}
                    <span className="mono">{shortSha(r.headSha)}</span>
                  </div>
                </td>
                <td>
                  <Badge tone={status.tone}>{status.label}</Badge>
                  {r.error && (
                    <div
                      className="cell-sub"
                      title={r.error}
                      style={{
                        maxWidth: 260,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {r.error}
                    </div>
                  )}
                </td>
                {!compact && (
                  <td className="hide-sm">
                    <span className="chip">{r.strategy}</span>
                    <div className="cell-sub">{r.servedModel ?? r.model}</div>
                  </td>
                )}
                <td className="r num">
                  {count(r.posted)}
                  <span className="muted"> / {count(r.candidates)}</span>
                </td>
                <td className="r num hide-sm">{duration(r.latencyMs)}</td>
                {!compact && <td className="r num hide-sm">{usd(r.costUsd)}</td>}
                <td className="r muted hide-sm" title={r.startedAt}>
                  {relativeTime(r.startedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ReviewsPage() {
  const { params } = useRoute();
  const repo = params.get('repo') ?? '';
  const status = params.get('status') ?? '';
  const q = params.get('q') ?? '';
  const offset = Number(params.get('offset') ?? 0) || 0;
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const repos = useApi<RepositorySummary[]>('/api/repositories');
  const query = new URLSearchParams({ limit: String(LIMIT), offset: String(offset) });
  if (repo) query.set('repo', repo);
  if (status) query.set('status', status);
  if (q) query.set('q', q);
  const reviews = useApi<{ items: ReviewSummary[]; total: number }>(`/api/reviews?${query}`);

  const go = (next: Record<string, string | number | undefined>) =>
    navigate(href('reviews', { repo, status, q, ...next }));

  return (
    <div className="stack">
      <PageHead
        title="Reviews"
        description="Every review run, newest first. Open one to see each candidate comment and what happened to it."
      />
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: search.trim(), offset: undefined });
        }}
      >
        <input
          className="input"
          type="search"
          placeholder="Search pull requests or repositories"
          aria-label="Search pull requests or repositories"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="select"
          aria-label="Repository"
          value={repo}
          onChange={(e) => go({ repo: e.target.value, offset: undefined })}
        >
          <option value="">All repositories</option>
          {repos.data?.map((r) => (
            <option key={r.id} value={r.id}>
              {r.fullName}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label="Status"
          value={status}
          onChange={(e) => go({ status: e.target.value, offset: undefined })}
        >
          <option value="">Any status</option>
          <option value="posted">Posted</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
        </select>
        {(repo || status || q) && (
          <button className="button" type="button" onClick={() => navigate(href('reviews'))}>
            Clear filters
          </button>
        )}
      </form>
      {reviews.error ? (
        <ErrorBox error={reviews.error} retry={reviews.reload} />
      ) : (
        <Card flush className={reviews.loading && reviews.data ? 'loading' : ''}>
          {reviews.data ? (
            <>
              <ReviewTable items={reviews.data.items} />
              <Pager
                total={reviews.data.total}
                offset={offset}
                limit={LIMIT}
                onPage={(o) => go({ offset: o || undefined })}
              />
            </>
          ) : (
            <Empty title="Loading…" />
          )}
        </Card>
      )}
    </div>
  );
}
