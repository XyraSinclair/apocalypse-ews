import { useEffect, useState } from 'react';
import { Clock, SourceLink, useWatchRead } from './watchShared';

export type OfficialNotice = {
  id: string; evidenceId: string; url: string; event: string; headline: string; description: string; instruction: string;
  issuer: string; area: string; stateCodes: string[];
  status: 'active' | 'upcoming' | 'expired' | 'cancelled' | 'superseded' | 'unverified';
  sentAt: string | null; effectiveAt: string | null; expiresAt: string | null; endsAt: string | null; observedAt: string;
  severity: string; urgency: string; certainty: string; references: string[]; contentTruncated: boolean;
};
type OfficialSnapshot = {
  generatedAt: string; selection: { state: string | null };
  coverage: { status: 'current' | 'degraded' | 'unavailable'; checkedAt: string | null; successAt: string | null; pollSeconds: number; staleAfterSeconds: number; sourceUrl: string; detail: string; truncated: boolean; unresolvedLocations: number };
  counts: { active: number; upcoming: number; ended: number; unverified: number }; notices: OfficialNotice[]; moreAvailable: boolean;
};
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY AS GU MP PR VI UM'.split(' ');
function timestamp(value: string | null) { return value ? Date.parse(value) : NaN; }
export function noticeStatus(notice: OfficialNotice, now: number): OfficialNotice['status'] {
  if (['cancelled', 'superseded', 'expired', 'unverified'].includes(notice.status)) return notice.status;
  const sent = timestamp(notice.sentAt), effective = timestamp(notice.effectiveAt), expires = timestamp(notice.expiresAt), ends = timestamp(notice.endsAt);
  if (!Number.isFinite(now) || ![sent, effective, expires].every(Number.isFinite) || (notice.endsAt !== null && !Number.isFinite(ends)) || expires <= effective || sent > now) return 'unverified';
  if (expires <= now || (Number.isFinite(ends) && ends <= now)) return 'expired';
  return effective > now ? 'upcoming' : 'active';
}

export default function OfficialNotices() {
  const [state, setState] = useState('');
  const [clock, setClock] = useState(() => ({ revision: 0, online: navigator.onLine, visible: document.visibilityState !== 'hidden' }));
  const { data, arrival, error, loading, retry } = useWatchRead<OfficialSnapshot>(`/api/watch/official${state ? `?state=${state}` : ''}`, '', clock.revision);
  useEffect(() => {
    let previousWall = Date.now(), previousMonotonic = performance.now();
    function tick(resume = false) {
      const wall = Date.now(), monotonic = performance.now();
      const elapsed = monotonic - previousMonotonic;
      // Monotonic clocks may pause during sleep; either clock can expose the gap.
      const discontinuity = elapsed < 0 || elapsed > 5000 || Math.abs(wall - previousWall - elapsed) > 2000;
      previousWall = wall; previousMonotonic = monotonic;
      const visible = document.visibilityState !== 'hidden';
      setClock(previous => ({ revision: previous.revision + (visible && (resume || discontinuity) ? 1 : 0), online: navigator.onLine, visible }));
    }
    const resume = () => tick(true);
    const update = () => tick();
    const timer = window.setInterval(update, 1000);
    window.addEventListener('pageshow', resume); window.addEventListener('focus', resume); window.addEventListener('online', resume); window.addEventListener('offline', update); document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); window.removeEventListener('pageshow', resume); window.removeEventListener('focus', resume); window.removeEventListener('online', resume); window.removeEventListener('offline', update); document.removeEventListener('visibilitychange', resume); };
  }, []);
  const success = timestamp(data?.coverage.successAt ?? null);
  const checked = timestamp(data?.coverage.checkedAt ?? null);
  const generated = timestamp(data?.generatedAt ?? null);
  const elapsed = arrival ? performance.now() - arrival.monotonic : NaN;
  const invalidClock = ![success, checked, generated, elapsed].every(Number.isFinite) || elapsed < 0 || success > generated || checked > generated;
  // Device wall time is diagnostic only; notice timing follows the server snapshot.
  const now = invalidClock ? NaN : generated + elapsed;
  const clockDisagreement = Boolean(arrival && Number.isFinite(generated) && Math.abs(Date.now() - (generated + elapsed)) > 60_000);
  const awaitingConfirmation = Boolean(data && (!clock.visible || arrival?.revision !== clock.revision));
  const stale = Boolean(data && (!Number.isFinite(data.coverage.staleAfterSeconds) || data.coverage.staleAfterSeconds <= 0 || now - success > data.coverage.staleAfterSeconds * 1000 || elapsed > data.coverage.staleAfterSeconds * 1000));
  const interrupted = !clock.online || Boolean(error) || invalidClock || awaitingConfirmation || stale || data?.coverage.status !== 'current' || Boolean(data?.coverage.truncated);
  const notices = (data?.notices ?? []).map(notice => ({ ...notice, status: noticeStatus(notice, now) }));
  const current = notices.filter(notice => notice.status === 'active' || notice.status === 'upcoming');
  const other = notices.filter(notice => notice.status !== 'active' && notice.status !== 'upcoming');
  function card(notice: OfficialNotice) {
    return <article className="official-notice-card" key={notice.id}>
      <div className="watch-section-heading"><h3>{notice.event || 'Official notice'}</h3><strong className="watch-badge">{notice.status}{interrupted && (notice.status === 'active' || notice.status === 'upcoming') ? ' by retained timing · not reconfirmed' : ''}</strong></div>
      <p><strong>{notice.headline}</strong></p><p>Issued by {notice.issuer || 'Issuer not provided'} · {notice.area || 'Area unresolved'}{!notice.stateCodes.length && ' · State unresolved: shown in every state view'}</p>
      <dl className="watch-facts"><div><dt>Sent</dt><dd><Clock value={notice.sentAt} /></dd></div><div><dt>Effective</dt><dd><Clock value={notice.effectiveAt} /></dd></div><div><dt>Expires</dt><dd><Clock value={notice.expiresAt} /></dd></div><div><dt>Ends</dt><dd><Clock value={notice.endsAt} /></dd></div></dl>
      <p>Source classification: {notice.severity} severity · {notice.urgency} urgency · {notice.certainty} certainty. These are issuer labels, not site predictions.</p>
      {notice.status !== 'active' && notice.status !== 'upcoming' && <p><strong>Reference only: do not treat the instructions below as a current directive.</strong></p>}
      <div className="official-source-text">{notice.description}</div><h4>Instructions from {notice.issuer || 'the issuer'}</h4><div className="official-source-text">{notice.instruction || 'No instruction text supplied. Consult the original notice.'}</div>
      {notice.contentTruncated && <p className="watch-error">Source text is incomplete here. Read the original notice for complete instructions.</p>}
      <p><SourceLink url={notice.url}>Original official notice</SourceLink> · Observed <Clock value={notice.observedAt} /></p>
    </article>;
  }
  return <section className="watch-panel official-notices" aria-labelledby="official-title">
    <p className="watch-eyebrow">OFFICIAL SOURCE NOTICES · NOT A PREDICTION</p><div className="watch-section-heading"><h2 id="official-title">Official instructions first</h2><label className="watch-filter">US state / territory<select value={state} onChange={event => setState(event.target.value)}><option value="">All areas</option>{STATES.map(code => <option key={code}>{code}</option>)}</select></label></div>
    <p>Selected public NWS emergency notices, independent of model review and processing budgets. Not a comprehensive emergency-alert service. State filtering is not address-level matching; read the issuer’s area before acting. Follow local official directions.</p>
    <p><SourceLink url="https://www.weather.gov/alerts">NWS alerts</SourceLink> · <SourceLink url="https://www.ready.gov/alerts">Set up primary official alerts</SourceLink> · <a href="/plan">Build your offline alert plan</a></p>
    <div className={interrupted ? 'watch-notice' : 'watch-muted'} role="status">{!clock.online ? 'Offline: notices cannot be confirmed.' : error ? data ? 'Refresh failed: retained notices are not reconfirmed.' : 'Official source unavailable: no snapshot could be loaded.' : !data ? loading ? 'Loading official source coverage. No current result yet.' : 'Official source unavailable.' : invalidClock ? 'Invalid server timing: notices cannot be confirmed.' : awaitingConfirmation ? 'View resumed or clock continuity lost: awaiting a fresh snapshot. Retained notices are not reconfirmed.' : stale ? 'Stale coverage: notices are not reconfirmed.' : `Source coverage: ${data.coverage.status}.`} {data?.coverage.detail} Absence of a notice is not an all-clear.</div>
    {clockDisagreement && <p className="watch-notice">Clock issue: device and server times differ by more than one minute. Notice timing uses the server snapshot plus elapsed time, not the device clock. This does not indicate safety or danger.</p>}
    {data && <><p>Last successful source check: <Clock value={data.coverage.successAt} /> · Last attempt: <Clock value={data.coverage.checkedAt} /> · Snapshot: <Clock value={data.generatedAt} />. Source checks every {data.coverage.pollSeconds}s; stale after {data.coverage.staleAfterSeconds}s.</p><p><SourceLink url={data.coverage.sourceUrl}>Official source feed</SourceLink></p>
      {(data.coverage.truncated || data.moreAvailable) && <p className="watch-error">Bounded or truncated results: this is not the complete notice set. Consult official channels. Snapshot totals: {data.counts.active} active, {data.counts.upcoming} upcoming, {data.counts.ended} ended, {data.counts.unverified} unverified. These counts describe the snapshot, not current timing.</p>}
      {data.coverage.unresolvedLocations > 0 && <p className="watch-notice">{data.coverage.unresolvedLocations} notices have unresolved state locations; they remain included rather than being silently filtered out.</p>}
      <h3>Active / upcoming by notice timing ({current.length})</h3>{current.length ? current.map(card) : <p>{interrupted ? 'No active or upcoming notices in the retained selection; current coverage is not established.' : 'No active or upcoming notices in this selected source snapshot. This does not establish safety or complete local coverage.'}</p>}
      <details><summary>Ended / unverified — reference only ({other.length})</summary>{other.map(card)}</details>
    </>}
    <button type="button" onClick={retry} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh official notices'}</button>
  </section>;
}
