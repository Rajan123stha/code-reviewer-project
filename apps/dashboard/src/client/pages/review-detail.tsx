import type { CandidateDetail, ReviewDetail } from '@reviewlens/db/dashboard-types';
import { useState } from 'react';
import { BarList } from '../charts.js';
import {
  Badge,
  CANDIDATE_STATUS,
  Card,
  Empty,
  ErrorBox,
  Icon,
  InlineCode,
  OUTCOME,
  PageHead,
  REVIEW_STATUS,
  ScoreBar,
} from '../components.js';
import { count, dateTime, duration, humanize, shortSha, tokens, usd } from '../format.js';
import { href, useApi } from '../lib.js';

type Filter = 'all' | 'posted' | 'not_posted';

const STATUS_ORDER = ['selected', 'over_cap', 'filtered', 'suppressed', 'duplicate', 'invalid'];

export function ReviewDetailPage({ id }: { id: string }) {
  const review = useApi<ReviewDetail>(`/api/reviews/${encodeURIComponent(id)}`);
  const [filter, setFilter] = useState<Filter>('all');

  if (review.error) return <ErrorBox error={review.error} retry={review.reload} />;
  const r = review.data;
  if (!r) return <Empty title="Loading…" />;

  const status = REVIEW_STATUS[r.status] ?? { tone: 'neutral' as const, label: r.status };
  const prUrl = `https://github.com/${r.repository}/pull/${r.pullNumber}`;
  const byStatus = new Map<string, number>();
  for (const c of r.candidateList) byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  // Posted comments first, in the order they were posted; then the rest by what stopped them.
  const order = (c: CandidateDetail) => STATUS_ORDER.indexOf(c.status) * 1000 + (c.rank ?? c.index);
  const shown = [...r.candidateList]
    .sort((a, b) => order(a) - order(b))
    .filter((c) => (filter === 'all' ? true : filter === 'posted' ? c.posted : !c.posted));
  const max = Math.max(1, ...byStatus.values());

  return (
    <div className="stack">
      <PageHead
        crumbs={
          <a href={href('reviews')}>
            <span style={{ verticalAlign: '-3px' }}>
              <Icon name="back" size={14} />
            </span>{' '}
            Reviews
          </a>
        }
        title={r.pullTitle}
        description={
          <span className="row">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span>
              {r.repository} #{r.pullNumber}
            </span>
            <span className="mono muted">{shortSha(r.headSha)}</span>
            <a href={prUrl} target="_blank" rel="noreferrer noopener">
              Open on GitHub <Icon name="external" size={13} />
            </a>
          </span>
        }
      />
      {r.error && (
        <div className="banner warn" role="alert">
          <strong>Failed:</strong> <span className="mono">{r.error}</span>
        </div>
      )}

      <div className="grid two">
        <Card title="Run">
          <dl className="meta">
            <Meta label="Strategy" value={<span className="chip">{r.strategy}</span>} />
            <Meta
              label="Model"
              value={r.servedModel ?? r.model}
              hint={r.fallbackUsed ? 'fallback model' : undefined}
            />
            <Meta
              label="Prompt"
              value={<span className="mono">{r.promptVersion}</span>}
              hint={r.promptHash ?? undefined}
            />
            <Meta label="Config hash" value={<span className="mono">{r.configHash}</span>} />
            <Meta
              label="Review time"
              value={duration(r.latencyMs)}
              hint={r.llmAttempts && r.llmAttempts > 1 ? `${r.llmAttempts} attempts` : undefined}
            />
            <Meta
              label="Tokens"
              value={`${tokens(r.tokensIn)} in · ${tokens(r.tokensOut)} out`}
              hint={r.cacheReadTokens ? `${tokens(r.cacheReadTokens)} from cache` : undefined}
            />
            <Meta label="Cost" value={usd(r.costUsd)} />
            <Meta
              label="Filter model"
              value={r.filterModel ? <span className="mono">{r.filterModel}</span> : 'off'}
            />
            <Meta label="Started" value={dateTime(r.startedAt)} />
          </dl>
        </Card>
        <Card
          title="Candidate comments"
          sub={`${count(r.candidateList.length)} proposed by the model`}
        >
          {r.candidateList.length === 0 ? (
            <Empty title="The model proposed nothing" />
          ) : (
            <BarList
              data={STATUS_ORDER.filter((s) => byStatus.has(s)).map((s) => {
                const meta = CANDIDATE_STATUS[s]!;
                return {
                  key: s,
                  label: meta.label,
                  tone: meta.tone,
                  share: byStatus.get(s)! / max,
                  value: count(byStatus.get(s)!),
                  title: meta.hint,
                };
              })}
            />
          )}
        </Card>
      </div>

      <Card
        title="Comments"
        actions={
          <div className="segmented" role="group" aria-label="Show comments">
            {(
              [
                ['all', 'All'],
                ['posted', 'Posted'],
                ['not_posted', 'Not posted'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        }
        flush
      >
        {shown.length === 0 ? (
          <Empty title="No comments in this view" />
        ) : (
          shown.map((c) => (
            <CandidateItem key={c.index} c={c} repo={r.repository} sha={r.headSha} />
          ))
        )}
      </Card>

      <Card title="Provenance">
        <div className="stack" style={{ gap: 10 }}>
          <details>
            <summary>Strategy config</summary>
            <pre className="code">{JSON.stringify(r.config, null, 2)}</pre>
          </details>
          <details>
            <summary>Context sent to the model</summary>
            <pre className="code">{JSON.stringify(r.contextStats, null, 2)}</pre>
          </details>
          <details>
            <summary>Secrets redacted before the LLM call</summary>
            <pre className="code">{JSON.stringify(r.redactions ?? {}, null, 2)}</pre>
          </details>
        </div>
      </Card>
    </div>
  );
}

function Meta({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string | undefined;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {hint && <div className="cell-sub mono">{hint}</div>}
      </dd>
    </div>
  );
}

function CandidateItem({ c, repo, sha }: { c: CandidateDetail; repo: string; sha: string }) {
  const status = CANDIDATE_STATUS[c.status] ?? {
    tone: 'neutral' as const,
    label: c.status,
    hint: '',
  };
  const fileUrl = `https://github.com/${repo}/blob/${sha}/${c.file}#L${c.line}`;
  return (
    <article className="comment">
      <div className="comment-head">
        <span title={status.hint}>
          <Badge tone={status.tone}>{status.label}</Badge>
        </span>
        <a className="mono" href={fileUrl} target="_blank" rel="noreferrer noopener">
          {c.file}:{c.line}
        </a>
        <span className="chip">{humanize(c.category)}</span>
        <span className="chip">{humanize(c.severity)}</span>
        {c.rank !== null && <span className="chip">rank {c.rank}</span>}
        <span className="spacer" />
        <span className="cell-sub">model confidence</span>
        <ScoreBar value={c.llmConfidence} label="Model confidence" />
        {c.filterScore !== null && (
          <>
            <span className="cell-sub">filter</span>
            <ScoreBar value={c.filterScore} label="Filter score" />
          </>
        )}
      </div>
      <p>
        <InlineCode text={c.claim} />
      </p>
      {c.rejectReason && <p className="cell-sub">Rejected: {humanize(c.rejectReason)}</p>}
      {c.duplicateOf !== null && <p className="cell-sub">Duplicate of comment #{c.duplicateOf}</p>}
      <pre className="code">{c.evidence}</pre>
      {c.suggestedFix && (
        <p className="secondary" style={{ marginTop: 8 }}>
          <strong>Suggested fix:</strong> <InlineCode text={c.suggestedFix} />
        </p>
      )}
      {c.posted && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="cell-sub">Feedback:</span>
          {c.outcomes.length === 0 ? (
            <span className="cell-sub">none yet</span>
          ) : (
            c.outcomes.map((o) => (
              <Badge key={o} tone={OUTCOME[o]?.tone ?? 'neutral'}>
                {OUTCOME[o]?.label ?? o}
              </Badge>
            ))
          )}
          {c.label !== null && (
            <span className="chip">label: {c.label === 1 ? 'useful' : 'not useful'}</span>
          )}
        </div>
      )}
    </article>
  );
}
