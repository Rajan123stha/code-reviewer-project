import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// --- Data -----------------------------------------------------------------------------------

export interface Resource<T> {
  data: T | undefined;
  error: string | undefined;
  /** True while a request is in flight; the previous data stays visible meanwhile. */
  loading: boolean;
  reload: () => void;
}

/** GET a JSON endpoint. Changing `path` refetches and keeps the old data until it lands. */
export function useApi<T>(path: string | null): Resource<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);
  const current = useRef(0);

  useEffect(() => {
    if (path === null) return;
    const request = ++current.current;
    const controller = new AbortController();
    setLoading(true);
    fetch(path, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok)
          throw new Error(body.error ?? `${response.status} ${response.statusText}`);
        return body as T;
      })
      .then((body) => {
        if (request !== current.current) return;
        setData(body);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || request !== current.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (request === current.current) setLoading(false);
      });
    return () => controller.abort();
  }, [path, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

// --- Routing (hash based: the server serves one page) -----------------------------------------

export interface Route {
  /** Path segments after `#/`, e.g. ["reviews", "12"]. */
  parts: string[];
  params: URLSearchParams;
}

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = raw.split('?');
  return {
    parts: path.split('/').filter(Boolean).map(decodeURIComponent),
    params: new URLSearchParams(query),
  };
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}

/** Build a hash link: href('reviews', { repo: 3 }) -> "#/reviews?repo=3". */
export function href(path: string, params: Record<string, string | number | undefined> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const q = query.toString();
  return `#/${path}${q ? `?${q}` : ''}`;
}

export function navigate(to: string) {
  window.location.hash = to.replace(/^#/, '');
}

// --- Theme ----------------------------------------------------------------------------------

export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'reviewlens.theme';

export function storedTheme(): Theme {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  try {
    if (theme === 'system') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked: the choice lasts for this page only.
  }
}
