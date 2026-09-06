import { FormEvent, ReactNode, useEffect, useRef, useState } from 'react';
import './watch.css';

type Evidence = {
  id: string; sourceId: string; sourceName: string; family: string; mechanism: string; dependenceGroup: string;
  title: string; summary: string; url: string; occurredAt: string | null; publishedAt: string | null;
  observedAt: string; region: string; topics: string[]; kind: string; status: string; data: Record<string, unknown>;
};
type Assessment = {
  summary: string; alternative: string; nextQuestion: string; attention: string; resolution: string;
  findings: { role: string; text: string; evidenceIds: string[] }[]; model: string;
};
type Incident = {
  id: string; title: string; region: string; topics: string[]; status: 'open' | 'resolved'; attention: string;
  generation: number; resolutionKind: string | null; reviewed?: boolean; publicVisible?: boolean;
  triage?: { disposition: string; reason: string; evidenceIds: string[] };
  firstObservedAt: string; lastObservedAt: string; sourceIds: string[]; evidenceCount: number;
  investigation: { status: string; lastError: string | null; updatedAt: string | null };
  observations?: Evidence[]; assessment?: Assessment; review?: { note: string; reviewedAt: string };
};
type Source = {
  id: string; name: string; family: string; mechanism: string; dependenceGroup: string; url: string;
  enabled: boolean; accessStatus: string; pollSeconds: number; staleSeconds: number; notes: string;
  health: string; lastCheckedAt: string | null; lastSuccessAt: string | null; lastObservedAt: string | null;
  lastError: string | null; observationCount: number; baselineSince: string | null;
  sampleStaleSeconds?: number | null; metadata?: Record<string, unknown> | null;
  recovery: { code: string | null; httpStatus: number | null; consecutiveFailures: number; nextCheckAt: string | null };
};
type Snapshot = {
  generatedAt: string; mode: 'machine_watch'; reviewPolicy: string;
  run: { lastStartedAt: string | null; lastFinishedAt: string | null; lastError: string | null; running: boolean };
  agent: { configured: boolean; model: string | null; reason: string | null };
  counts: { sources: number; enabled: number; healthy: number; degraded: number; pending: number; openIncidents: number };
  budget: { limitNano: number; usedNano: number; reservedNano: number; remainingNano: number; resetsAt: string };
  processing: { state: 'running' | 'paused_budget' | 'unavailable' | 'idle' | 'backlog'; pendingTriage: number; pendingInvestigation: number; failed: number; oldestPendingAt: string | null; lastCompletedAt: string | null; nextEligibleAt: string | null };
  sources: Source[]; incidents: Incident[];
  page: { nextCursor: string | null; status: string };
  handover: { generatedAt: string | null; summary: string; openQuestions: string[]; coverageGaps: string[] };
};

const POLL_MS = 30_000;
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'America/Los_Angeles' });
const money = (nano: number) => `$${(nano / 1_000_000_000).toFixed(3)}`;
function Clock({ value }: { value: string | null }) {
  return value && Number.isFinite(Date.parse(value))
    ? <time dateTime={value}>{DATE_FORMAT.format(new Date(value))} Pacific</time> : <span>Not recorded</span>;
}
function age(value: string | null, now: number) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'not yet recorded';
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}
function label(value: string) { return value.replaceAll('_', ' '); }
function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  let safe = false;
  try { const parsed = new URL(url); safe = ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password; } catch { /* Invalid source URLs are never linked. */ }
  return safe ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children} <span aria-hidden="true">↗</span></a> : <span>{children} (link unavailable)</span>;
}
async function request<T>(path: string, token: string, signal: AbortSignal, body?: object): Promise<T> {
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
function useWatchRead<T>(path: string, token: string, revision = 0) {
  const [state, setState] = useState<{ path: string; token: string; data: T | null; error: string | null; loading: boolean }>({ path, token, data: null, error: null, loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let stopped = false;
    let active: AbortController | null = null;
    let timer: number | undefined;
    async function load() {
      active = new AbortController();
      const deadline = setTimeout(() => active?.abort(), 15_000);
      setState(previous => ({ path, token, data: previous.path === path && previous.token === token ? previous.data : null, error: previous.path === path && previous.token === token ? previous.error : null, loading: true }));
      try {
        const data = await request<T>(path, token, active.signal);
        if (!stopped) setState({ path, token, data, error: null, loading: false });
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
  return { ...(state.path === path && state.token === token ? state : { data: null, error: null, loading: true }), retry: () => setAttempt(n => n + 1) };
}

export function WatchNavigation() {
  const path = window.location.pathname;
  return <header className="watch-navigation"><a className="watch-wordmark" href="/">warning<span>.watch</span></a><nav aria-label="Primary">
    <a href="/watch" aria-current={path === '/' || path === '/watch' ? 'page' : undefined}>Watch</a>
    <a href="/aviation" aria-current={path === '/aviation' ? 'page' : undefined}>Aviation</a>
    <a href="/event-signals" aria-current={path.startsWith('/event-signals') ? 'page' : undefined}>Event signals</a>
  </nav></header>;
}

export default function WatchPage() {
  const [token, setToken] = useState('');
  const [credential, setCredential] = useState('');
  const [now, setNow] = useState(Date.now());
  const [revision, setRevision] = useState(0);
  const [queue, setQueue] = useState('open');
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const [sourceFilter, setSourceFilter] = useState('enabled');
  const currentCursor = cursors[cursors.length - 1];
  const queueQuery = `?status=${queue}${currentCursor ? `&cursor=${encodeURIComponent(currentCursor)}` : ''}`;
  const { data, error, loading, retry } = useWatchRead<Snapshot>(`${token ? '/api/admin/watch' : '/api/watch'}${queueQuery}`, token, revision);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  const old = data ? now - Date.parse(data.generatedAt) > POLL_MS * 3 : false;
  const runOverdue = data ? data.run.lastFinishedAt
    ? now - Date.parse(data.run.lastFinishedAt) > 6 * 60_000
    : Boolean(data.run.lastStartedAt && now - Date.parse(data.run.lastStartedAt) > 4 * 60_000) : false;
  const incidents = data?.incidents ?? [];
  const sources = data?.sources.filter(item => sourceFilter === 'all' || (sourceFilter === 'enabled' ? item.enabled : !item.enabled)) ?? [];
  const operating = !data ? 'Connecting' : error || old ? 'Update interrupted' : runOverdue ? 'Watch overdue'
    : data.processing.state === 'paused_budget' ? 'Investigations paused'
    : data.processing.state === 'unavailable' ? 'Investigations unavailable'
    : data.processing.state === 'running' ? 'Investigating'
    : data.processing.state === 'backlog' ? 'Investigation backlog'
    : data.counts.degraded ? 'Source coverage degraded'
    : data.run.lastError ? 'Run degraded' : data.run.running ? 'Collecting sources'
    : !data.run.lastFinishedAt ? 'Warming up' : 'Watch up to date';
  function enterOperator(event: FormEvent) { event.preventDefault(); setToken(credential.trim()); setCredential(''); setCursors([null]); }
  return <main className="watch-page">
    <section className="watch-intro" aria-labelledby="watch-title">
      <div><p className="watch-eyebrow">DIGITAL EARLY WARNING · PUBLIC EVIDENCE</p><h1 id="watch-title">Continuous digital watch</h1><p className="watch-lede">Source coverage, investigation progress, and deliberately published evidence. Raw leads and machine findings stay in the private watch.</p></div>
      <div className="watch-operating"><span className="watch-eyebrow">OPERATING STATE</span><strong>{operating}</strong><span>Snapshot {age(data?.generatedAt ?? null, now)}</span><span>Refresh every 30 seconds</span></div>
    </section>
    <div className="watch-notice">Follow official emergency instructions. Investigation priority describes review work, not threat level.</div>
    <section className="watch-panel watch-operator" aria-label="Operator access">
      {token ? <div className="watch-section-heading"><div><h2>Operator session</h2><p>Reviews stay private unless you explicitly publish source evidence. Machine drafts and review notes are never public.</p></div><button onClick={() => { setToken(''); setCredential(''); }}>Leave operator mode</button></div> : <details><summary>Operator access</summary><p>Existing Bearer token only. Kept in component memory; cleared when you leave or reload.</p><form onSubmit={enterOperator}><label>Operator token<input type="password" value={credential} onChange={event => setCredential(event.target.value)} autoComplete="off" spellCheck={false} required /></label><button type="submit" disabled={!credential.trim()}>Open private watch</button></form></details>}
    </section>
    {error && <div className="watch-error" role="alert">{error} {data ? 'Last successful data remains below; its clocks continue to age.' : 'No watch data is available.'} <button onClick={retry} disabled={loading}>Retry now</button></div>}
    {runOverdue && <div className="watch-error" role="alert">The watch has not completed on schedule. These are retained observations, not a current situation assessment.</div>}
    {!data && <section className="watch-panel watch-empty" aria-live="polite"><h2>{loading ? 'Connecting to the watch' : 'Watch unavailable'}</h2><p>{loading ? 'Waiting for the first factual snapshot. No coverage or incident state has been inferred.' : 'The watch could not be read. This is not an all-clear.'}</p></section>}
    {data && <>
      <section className="watch-metrics" aria-label="Watch coverage counts">
        <div><strong>{data.counts.enabled}<small> / {data.counts.sources}</small></strong><span>sources enabled</span></div>
        <div><strong>{data.counts.healthy}</strong><span>healthy source feeds</span></div>
        <div><strong>{data.counts.degraded}</strong><span>degraded sources</span></div>
        <div><strong>{data.counts.openIncidents}</strong><span>{token ? 'open review threads' : 'published open threads'}</span></div>
        <div><strong>{data.processing.pendingTriage + data.processing.pendingInvestigation}</strong><span>leads awaiting processing</span></div>
      </section>
      <section className="watch-panel watch-progress" aria-labelledby="progress-heading">
        <div className="watch-section-heading"><div><p className="watch-eyebrow">COLLECTION IS NOT INVESTIGATION</p><h2 id="progress-heading">Work moving through the watch</h2></div><span className="watch-badge">{label(data.processing.state)}</span></div>
        <p>{data.processing.pendingTriage} leads awaiting screening · {data.processing.pendingInvestigation} investigations awaiting work · {data.processing.failed} failed jobs needing recovery.</p>
        {data.processing.state === 'paused_budget' && <p className="watch-error">The processing allowance is exhausted or cannot cover the next bounded job. Collection continues; this is not a fully attended watch. Next eligibility: <Clock value={data.processing.nextEligibleAt || data.budget.resetsAt} />.</p>}
        {data.processing.state === 'unavailable' && <p className="watch-error">The investigation provider is unavailable. Retained source material is not a completed assessment.</p>}
        <dl className="watch-facts"><div><dt>Last completed analysis</dt><dd><Clock value={data.processing.lastCompletedAt} /></dd></div><div><dt>Oldest waiting lead</dt><dd><Clock value={data.processing.oldestPendingAt} />{data.processing.oldestPendingAt && ` · ${age(data.processing.oldestPendingAt, now)}`}</dd></div><div><dt>Provider allowance</dt><dd>{money(data.budget.usedNano)} used or conservatively charged + {money(data.budget.reservedNano)} reserved / {money(data.budget.limitNano)} per UTC day</dd></div></dl>
        <p className="watch-muted">Screening removes explicit background material from active work; it does not declare a source true, false, or safe. Full investigations retain independent specialist and skeptical review.</p>
      </section>
      <div className="watch-workspace">
        <section className="watch-panel watch-queue" aria-labelledby="incident-heading">
          <div className="watch-section-heading"><div><p className="watch-eyebrow">{token ? 'PRIVATE INCIDENT MEMORY' : 'REVIEWED SOURCE EVIDENCE'}</p><h2 id="incident-heading">{token ? 'Investigation queue' : 'Published evidence'}</h2></div><label className="watch-filter">Show<select value={queue} onChange={event => { setQueue(event.target.value); setCursors([null]); }}><option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All threads</option></select></label></div>
          <p className="watch-muted">{incidents.length} returned threads · {data.counts.openIncidents} open overall. {token ? 'Private leads are unverified; expand a thread to inspect screening and findings.' : 'Only source evidence explicitly released by an operator appears here. A review is not proof of the source’s claim.'}</p>
          {!incidents.length && <div className="watch-empty"><h3>{!data.run.lastFinishedAt ? 'Building the first source baseline' : token ? 'No matching review threads' : 'No source evidence published in this view'}</h3><p>{token ? 'Background material remains in resolved history with its routing reason.' : 'New reports are retained privately for screening and investigation, not republished as events.'} An empty queue is not a safety assessment.</p></div>}
          {incidents.map(incident => <IncidentCard key={`${token ? 'operator' : 'public'}:${incident.id}`} incident={incident} token={token} now={now} onReview={() => setRevision(n => n + 1)} />)}
          <nav className="watch-section-heading" aria-label="Incident pages">
            <button disabled={loading || cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}>Previous page</button>
            <span>Page {cursors.length}</span>
            <button disabled={loading || !data.page.nextCursor} onClick={() => { if (data.page.nextCursor) setCursors(value => [...value, data.page.nextCursor]); }}>Next page</button>
          </nav>
        </section>
        <aside className="watch-panel watch-handover" aria-labelledby="handover-heading">
          <p className="watch-eyebrow">02 / SHIFT HANDOVER</p><h2 id="handover-heading">What remains open</h2>
          <p>{data.handover.summary || 'No completed handover yet.'}</p>
          <p className="watch-clock"><Clock value={data.handover.generatedAt} /></p>
          {token && <><h3>Open questions</h3>{data.handover.openQuestions.length ? <ul>{data.handover.openQuestions.map((question, index) => <li key={index}>{question}</li>)}</ul> : <p className="watch-muted">No current investigator questions recorded.</p>}</>}
          <h3>Coverage gaps</h3>{data.handover.coverageGaps.length ? <ul>{data.handover.coverageGaps.map((gap, index) => <li key={index}>{gap}</li>)}</ul> : <p className="watch-muted">No gaps recorded in the handover. The source registry remains the coverage boundary.</p>}
          <dl className="watch-facts"><div><dt>Run started</dt><dd><Clock value={data.run.lastStartedAt} /></dd></div><div><dt>Run finished</dt><dd><Clock value={data.run.lastFinishedAt} /></dd></div><div><dt>Investigation engine</dt><dd>{data.agent.configured ? 'Configured' : 'Not configured'}{data.agent.reason ? ` · ${data.agent.reason}` : ''}</dd></div></dl>
          {data.run.lastError && <p className="watch-error">{data.run.lastError}</p>}
        </aside>
      </div>
      <section className="watch-panel" aria-labelledby="source-heading">
        <div className="watch-section-heading"><div><p className="watch-eyebrow">03 / COVERAGE & DEPENDENCE</p><h2 id="source-heading">Source registry</h2></div><label className="watch-filter">Show<select value={sourceFilter} onChange={event => setSourceFilter(event.target.value)}><option value="all">All sources</option><option value="enabled">Enabled</option><option value="uncovered">Access-gated / uncovered</option></select></label></div>
        <p className="watch-muted">A successful check is not a new sample. Sources sharing an upstream group are not independent corroboration.</p>
        {!sources.length && <p className="watch-empty">No sources in this view. Coverage has not been inferred.</p>}
        <div className="watch-source-grid">{sources.map(source => <article className="watch-source" key={source.id}>
          <div className="watch-source-heading"><h3><SourceLink url={source.url}>{source.name}</SourceLink></h3><span className={`watch-badge watch-health-${source.health}`}>{label(source.health)}</span></div>
          <p className="watch-muted">{source.family} · {source.mechanism}</p>
          {!source.enabled && <p className="watch-access">Not covered · {label(source.accessStatus)}</p>}
          {source.enabled && source.accessStatus !== 'public' && <p className="watch-muted">Access: {label(source.accessStatus)}</p>}
          <dl className="watch-facts"><div><dt>Upstream group</dt><dd>{source.dependenceGroup}</dd></div><div><dt>Last check</dt><dd><Clock value={source.lastCheckedAt} /></dd></div><div><dt>Last success</dt><dd><Clock value={source.lastSuccessAt} /></dd></div><div><dt>Last observation</dt><dd><Clock value={source.lastObservedAt} />{source.lastObservedAt && <span className="watch-muted"> · {age(source.lastObservedAt, now)}</span>}</dd></div><div><dt>Stored observations</dt><dd>{source.observationCount}</dd></div></dl>
          {typeof source.metadata?.sourceUpdatedAt === 'string' && <p className="watch-clock">Upstream progress: <Clock value={source.metadata.sourceUpdatedAt} /> · {age(source.metadata.sourceUpdatedAt, now)}</p>}
          {(source.metadata?.backlog === true || source.metadata?.truncated === true) && <p className="watch-access">{source.metadata.backlog === true ? 'Collection is catching up; current coverage is incomplete.' : 'This response reached its collection window or result bound.'}</p>}
          <details><summary>Limitations & collection</summary><p>{source.notes || 'No additional source notes recorded.'}</p><dl className="watch-facts"><div><dt>Check cadence</dt><dd>{source.pollSeconds}s</dd></div><div><dt>Stale threshold</dt><dd>{source.staleSeconds}s</dd></div><div><dt>Baseline since</dt><dd><Clock value={source.baselineSince} /></dd></div></dl></details>
          {source.metadata && <details><summary>Observed coverage</summary><pre>{JSON.stringify(source.metadata, null, 2)}</pre></details>}
          {source.lastError && <p className="watch-error">{source.lastError}</p>}
          {source.enabled && source.recovery.consecutiveFailures > 0 && <p className="watch-access">{source.recovery.httpStatus ? `Upstream HTTP ${source.recovery.httpStatus}` : label(source.recovery.code || 'source failure')} · {source.recovery.consecutiveFailures} consecutive failed checks. Next eligible check: <Clock value={source.recovery.nextCheckAt} />. Prior evidence and continuation are retained.</p>}
        </article>)}</div>
      </section>
      <p className="watch-policy">{data.reviewPolicy} <span>Snapshot generated <Clock value={data.generatedAt} />.</span></p>
    </>}
    <footer className="watch-footer"><span>Evidence before interpretation.</span><a href="/signup">Aviation alert signup</a><a href="/aviation#methodology">Aviation methodology</a></footer>
  </main>;
}

function IncidentCard({ incident, token, now, onReview }: { incident: Incident; token: string; now: number; onReview: () => void }) {
  const [expanded, setExpanded] = useState(false);
  return <article className="watch-incident"><button className="watch-incident-toggle" aria-expanded={expanded} aria-controls={`incident-${incident.id}`} onClick={() => setExpanded(value => !value)}>
    <span className="watch-incident-top"><span className="watch-badge">{incident.status}</span><span className="watch-priority">Investigation priority: {label(incident.attention)}</span><span aria-hidden="true">{expanded ? '−' : '+'}</span></span>
    <span className="watch-eyebrow">Source material</span><strong><q>{incident.title}</q></strong><span className="watch-muted">{incident.region || 'Region unspecified'} · {incident.evidenceCount} evidence records · {incident.sourceIds.length} sources</span><span className="watch-clock">Last observed {age(incident.lastObservedAt, now)} · investigation {incident.investigation.status}</span>
  </button>{expanded && <div id={`incident-${incident.id}`} className="watch-incident-body"><IncidentDetail id={incident.id} token={token} now={now} onReview={onReview} /></div>}</article>;
}
function IncidentDetail({ id, token, now, onReview }: { id: string; token: string; now: number; onReview: () => void }) {
  const [revision, setRevision] = useState(0);
  const { data, error, loading, retry } = useWatchRead<Incident>(`${token ? '/api/admin/watch' : '/api/watch'}/incidents/${encodeURIComponent(id)}`, token, revision);
  const [note, setNote] = useState('');
  const [reviewStatus, setReviewStatus] = useState<'open' | 'resolved'>('open');
  const [publishEvidence, setPublishEvidence] = useState(false);
  const [reviewGeneration, setReviewGeneration] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [reviewMessage, setReviewMessage] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); controller.current = null; }, []);
  async function review(event: FormEvent) {
    event.preventDefault();
    if (!token || saving || !data || reviewGeneration !== data.generation) return;
    const active = new AbortController(); controller.current = active;
    const deadline = setTimeout(() => active.abort(), 15_000);
    setSaving(true); setReviewMessage('');
    try {
      await request(`/api/admin/watch/incidents/${encodeURIComponent(id)}/review`, token, active.signal, { status: reviewStatus, note: note.trim(), publishEvidence, expectedGeneration: reviewGeneration });
      if (controller.current !== active || active.signal.aborted) return;
      setNote(''); setPublishEvidence(false); setReviewGeneration(null); setReviewMessage(publishEvidence ? 'Source evidence published for this generation. Notes and drafts remain private; no subscriber alert sent.' : 'Private review saved. Source evidence is not published.'); setRevision(n => n + 1); onReview();
    } catch (error) {
      if (controller.current === active) setReviewMessage(active.signal.aborted ? 'Review request interrupted. Check the saved review before retrying.' : error instanceof Error ? error.message : 'Review could not be saved.');
    } finally { clearTimeout(deadline); if (controller.current === active) setSaving(false); }
  }
  const evidence = [...(data?.observations ?? [])].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return <>
    {error && <p className="watch-error" role="alert">{error} {data && 'Previously loaded evidence is retained.'} <button onClick={retry} disabled={loading}>Retry evidence</button></p>}
    {!data && <p role="status">{loading ? 'Loading source evidence…' : 'Evidence unavailable.'}</p>}
    {data && <>
      <dl className="watch-facts"><div><dt>First observed</dt><dd><Clock value={data.firstObservedAt} /></dd></div><div><dt>Last observed</dt><dd><Clock value={data.lastObservedAt} /> · {age(data.lastObservedAt, now)}</dd></div></dl>
      <h3>Evidence chronology</h3><p className="watch-muted">Showing {evidence.length} of {data.evidenceCount} retained records, oldest displayed observation first. Cited originals accompany the current assessment; publication clocks come from the source.</p>
      {!evidence.length && <p>No evidence records returned for this thread.</p>}
      <ol className="watch-evidence">{evidence.map(item => <li id={`evidence-${id}-${item.id}`} key={item.id}>
        <p className="watch-eyebrow">{item.sourceName} · {label(item.kind)} · {item.data.expired === true ? 'expired' : item.data.current === false ? 'historical / no longer current' : label(item.status)}</p>
        <h4><SourceLink url={item.url}>{item.title}</SourceLink></h4><p>{item.summary}</p>
        <dl className="watch-facts">
          <div><dt>Published</dt><dd><Clock value={item.publishedAt} /></dd></div>
          <div><dt>Observed</dt><dd><Clock value={item.observedAt} /></dd></div>
          {item.occurredAt && <div><dt>Occurred</dt><dd><Clock value={item.occurredAt} /></dd></div>}
          <div><dt>Upstream group</dt><dd>{item.dependenceGroup}</dd></div>
          <div><dt>Evidence ID</dt><dd>{item.id}</dd></div>
          {typeof item.data.supersedes === 'string' && <div><dt>Supersedes</dt><dd>{item.data.supersedes}</dd></div>}
        </dl>
        {Object.keys(item.data).length > 0 && <details><summary>Source fields</summary><pre>{JSON.stringify(item.data, null, 2)}</pre></details>}
      </li>)}</ol>
      {token && <section className="watch-draft"><p className="watch-eyebrow">PRIVATE / MACHINE DRAFT · NOT A PUBLIC ASSESSMENT</p><h3>Investigation {data.investigation.status}</h3>{data.investigation.lastError && <p className="watch-error">{data.investigation.lastError}</p>}{data.assessment ? <><p>{data.assessment.summary}</p><h4>Alternative explanation</h4><p>{data.assessment.alternative}</p><h4>Next question</h4><p>{data.assessment.nextQuestion}</p>{data.assessment.findings.map((finding, index) => <div className="watch-finding" key={index}><h4>{label(finding.role)}</h4><p>{finding.text}</p><div className="watch-citations">Evidence: {finding.evidenceIds.map(evidenceId => evidence.some(item => item.id === evidenceId) ? <a key={evidenceId} href={`#evidence-${id}-${evidenceId}`}>{evidenceId}</a> : <span key={evidenceId}>{evidenceId} (not returned)</span>)}</div></div>)}<p className="watch-muted">Model: {data.assessment.model} · Resolution draft: {data.assessment.resolution}</p></> : <p>No completed machine draft.</p>}
        {data.triage && <div className="watch-finding"><h4>Screening: {label(data.triage.disposition)}</h4><p>{data.triage.reason}</p></div>}
        {data.resolutionKind && <p className="watch-access">Work disposition: {label(data.resolutionKind)}. This closes review work, not the underlying world situation.</p>}
        {data.review && <div className="watch-finding"><h4>Saved human review</h4><p>{data.review.note}</p><Clock value={data.review.reviewedAt} /></div>}
        <form className="watch-review" onSubmit={review}><label>Private human review note<textarea value={note} onChange={event => { setNote(event.target.value); if (reviewGeneration == null) setReviewGeneration(data.generation); }} required maxLength={4000} rows={3} disabled={saving} /></label><label>Thread status<select value={reviewStatus} onChange={event => { setReviewStatus(event.target.value as 'open' | 'resolved'); if (reviewGeneration == null) setReviewGeneration(data.generation); }} disabled={saving}><option value="open">Open</option><option value="resolved">Resolved</option></select></label><label className="watch-publish"><input type="checkbox" checked={publishEvidence} onChange={event => { setPublishEvidence(event.target.checked); if (reviewGeneration == null) setReviewGeneration(data.generation); }} disabled={saving} />Publish this generation’s source evidence on the public watch. Notes and machine findings stay private.</label>{reviewGeneration != null && reviewGeneration !== data.generation && <p className="watch-error">Evidence changed while you were reviewing. Inspect the new evidence before saving. <button type="button" onClick={() => { setReviewGeneration(data.generation); setPublishEvidence(false); }}>Use the current evidence</button></p>}<button disabled={saving || !note.trim() || reviewGeneration !== data.generation}>{saving ? 'Saving review…' : publishEvidence ? 'Save review and publish evidence' : 'Save private review'}</button>{reviewMessage && <p role="status">{reviewMessage}</p>}</form>
      </section>}
    </>}
  </>;
}
