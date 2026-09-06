import { ReactNode, useCallback, useEffect, useState } from 'react';

const POLL_MS = 30_000;
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'America/Los_Angeles' });
export function Clock({ value }: { value: string | null }) {
  return value && Number.isFinite(Date.parse(value))
    ? <time dateTime={value}>{DATE_FORMAT.format(new Date(value))} Pacific</time> : <span>Not recorded</span>;
}
export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  let safe = false;
  try { const parsed = new URL(url); safe = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { /* Invalid source URLs are never linked. */ }
  return safe ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children} <span aria-hidden="true">↗</span></a> : <span>{children} (link unavailable)</span>;
}
export async function request<T>(path: string, token: string, signal: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(path, {
    signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403
    ? 'Operator access denied. Check your token or leave operator mode.' : `Watch request failed (HTTP ${response.status}).`);
  return response.json();
}
export function useWatchRead<T>(path: string, token: string, revision = 0) {
  const [state, setState] = useState<{ path: string; token: string; data: T | null; arrival: { monotonic: number; revision: number } | null; error: string | null; loading: boolean }>({ path, token, data: null, arrival: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    let stopped = false;
    let active: AbortController | null = null;
    let timer: number | undefined;
    async function load() {
      active = new AbortController();
      const deadline = setTimeout(() => active?.abort(), 15_000);
      setState(previous => ({ path, token, data: previous.path === path && previous.token === token ? previous.data : null, arrival: previous.path === path && previous.token === token ? previous.arrival : null, error: previous.path === path && previous.token === token ? previous.error : null, loading: true }));
      try {
        const data = await request<T>(path, token, active.signal);
        if (!stopped) setState({ path, token, data, arrival: { monotonic: performance.now(), revision }, error: null, loading: false });
      } catch (error) {
        if (!stopped) setState(previous => ({ ...previous, loading: false, error: active?.signal.aborted ? 'Watch request timed out.' : error instanceof Error ? error.message : 'Watch request failed.' }));
      } finally {
        clearTimeout(deadline);
        if (!stopped) timer = window.setTimeout(load, POLL_MS);
      }
    }
    void load();
    return () => { stopped = true; clearTimeout(timer); active?.abort(); };
  }, [path, token, revision, attempt]);
  return { ...(state.path === path && state.token === token ? state : { data: null, arrival: null, error: null, loading: true }), retry };
}

