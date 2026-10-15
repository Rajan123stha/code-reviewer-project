import { useEffect, useState } from 'react';
import { Icon } from './components.js';
import { applyTheme, href, storedTheme, useApi, useRoute, type Theme } from './lib.js';
import { ExperimentDetailPage, ExperimentsPage } from './pages/experiments.js';
import { FeedbackPage } from './pages/feedback.js';
import { OverviewPage } from './pages/overview.js';
import { RepositoriesPage } from './pages/repositories.js';
import { ReviewDetailPage } from './pages/review-detail.js';
import { ReviewsPage } from './pages/reviews.js';

const NAV = [
  { path: '', label: 'Overview', icon: 'overview' },
  { path: 'reviews', label: 'Reviews', icon: 'reviews' },
  { path: 'repositories', label: 'Repositories', icon: 'repos' },
  { path: 'feedback', label: 'Feedback', icon: 'feedback' },
  { path: 'experiments', label: 'Experiments', icon: 'experiments' },
] as const;

const TITLES: Record<string, string> = {
  '': 'Overview',
  reviews: 'Reviews',
  repositories: 'Repositories',
  feedback: 'Feedback',
  experiments: 'Experiments',
};

function Page({ parts }: { parts: string[] }) {
  const [section = '', id, extra] = parts;
  if (section === 'reviews' && id) return <ReviewDetailPage id={id} />;
  if (section === 'reviews') return <ReviewsPage />;
  if (section === 'repositories') return <RepositoriesPage />;
  if (section === 'feedback') return <FeedbackPage />;
  if (section === 'experiments' && id && extra)
    return <ExperimentDetailPage name={id} hash={extra} />;
  if (section === 'experiments') return <ExperimentsPage />;
  if (section === '') return <OverviewPage />;
  return (
    <div className="card empty">
      <h3>Page not found</h3>
      <p>
        <a href={href('')}>Back to the overview</a>
      </p>
    </div>
  );
}

function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => applyTheme(theme), [theme]);
  return (
    <div className="segmented" role="group" aria-label="Color theme">
      {(['system', 'light', 'dark'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
          {t === 'system' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const { parts } = useRoute();
  const meta = useApi<{ demo: boolean }>('/api/meta');
  const section = parts[0] ?? '';

  useEffect(() => {
    document.title = `${TITLES[section] ?? 'Reviewlens'} · Reviewlens`;
    window.scrollTo(0, 0);
  }, [section, parts[1]]);

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <a className="brand" href={href('')}>
          <span className="brand-mark" aria-hidden="true">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="6" />
              <path d="m20 20-4.2-4.2" />
            </svg>
          </span>
          Reviewlens
        </a>
        {NAV.map((item) => (
          <a
            key={item.path}
            className="nav-link"
            href={href(item.path)}
            aria-current={section === item.path ? 'page' : undefined}
          >
            <Icon name={item.icon} />
            {item.label}
          </a>
        ))}
        <div className="sidebar-foot">
          <ThemeSwitch />
        </div>
      </nav>
      <main className="main">
        {meta.data?.demo && (
          <div className="banner warn" role="note">
            <span>
              <strong>Demo data.</strong> Reviews, repositories and feedback on this page are
              synthetic, generated for previewing the dashboard. Experiment results are real files
              from eval/results.
            </span>
          </div>
        )}
        <Page parts={parts} />
      </main>
    </div>
  );
}
