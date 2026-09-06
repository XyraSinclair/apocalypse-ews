import { useEffect, useRef, useState } from 'react';
import { Clock, SourceLink } from './watchShared';
import './watch.css';

const STORAGE_KEY = 'warning.watch.resident-plan.v1';
const MAX_FIELD = 2400;
const MAX_STORED = 60000;
const GUIDANCE = {
  url: 'https://www.ready.gov/radiation', sourceUpdated: '2025-01-07', reviewed: '2026-09-06',
  actions: [
    ['Get inside', 'For a radiation warning, immediately get inside the nearest building, away from windows. If a nuclear detonation occurs, take cover from the blast; after the shock wave passes, get inside. A basement or the center of a large building offers better shelter.'],
    ['Stay inside', 'For the first 24 hours after a detonation, stay inside unless there is an immediate hazard such as fire, gas leak, building collapse, or serious injury, or authorities direct otherwise. Do not go outside to collect loved ones; follow school and care-facility plans.'],
    ['Stay tuned', 'Follow current official instructions for your area, including evacuation directions. Use your battery-powered radio if internet or phones fail. Twenty-four hours passing, or silence from this site, is not an all-clear.']
  ],
  items: [
    ['Use more than one alert channel', 'In the United States, Wireless Emergency Alerts need no signup on compatible phones; check your phone’s emergency-alert settings. Separate local agency phone, text, or email enrollment complements WEA. Outside the US, use your national and local official alert services. Keep a battery-powered or hand-crank radio and spare power. This site does not wake a closed or locked device. Aviation signup is not a nuclear-alert subscription. Source: https://www.weather.gov/wrn/wea (reviewed 2026-09-05; source update date not stated).'],
    ['Identify shelter before you need it', 'Identify nearby substantial buildings where you spend time. Check accessible entry, hours, keys, interior locations away from windows, and alternatives.'],
    ['Connect your household', 'Agree on contact arrangements, including an out-of-area contact. Learn school and care-facility plans now. Prepare supplies, medicines, accessibility support, pet needs, and a printed contact copy. Source: https://www.cdc.gov/radiation-emergencies/response/get-inside.html (source reviewed 2024-04-15; guidance reviewed 2026-09-06).']
  ]
};
const SECTIONS = [
  { title: '1 · Set up your primary alert routes', fields: [
    ['phone', 'Phone alert route', 'Phone type, where its emergency-alert settings are, and how you checked them.'],
    ['localUrl', 'Local official enrollment URL', 'Find your city or county emergency-management website; record its official signup URL.'],
    ['localStatus', 'Local enrollment status and next action', 'Not started, enrolled, confirmation pending, or unavailable; record what you will do next.'],
    ['radio', 'Radio and backup power', 'Where the battery / hand-crank radio is, a local station, batteries, and who can use it.']
  ] },
  { title: '2 · Choose reachable shelter', fields: [
    ['home', 'At home', 'Building and interior / basement location; keys, entry hours, stairs, mobility access, and alternatives.'],
    ['work', 'At work or school', 'Shelter location and access constraints; ask the building or school about its plan.'],
    ['away', 'Away from home', 'Nearby substantial buildings where you spend time; access constraints and an alternative.']
  ] },
  { title: '3 · Make contact arrangements', fields: [
    ['household', 'Household contacts and arrangement', 'Names, phone numbers, how to check in, and where a printed contact copy is kept.'],
    ['outOfArea', 'Out-of-area contact and offline fallback', 'Name and number; what each person will do if phone or internet service fails.'],
    ['care', 'School, care, dependents, and pets', 'Facility contact and emergency plan; pickup / reunification rules, carers, pet needs.']
  ] },
  { title: '4 · Prepare for practical needs', fields: [
    ['supplies', 'Supplies and where to find them', 'Water, food, medicines, radio, lighting, chargers, and essential documents.'],
    ['access', 'Accessibility, language, and medical support', 'Communication access, mobility, power-dependent equipment, helpers, and backup arrangements.'],
    ['next', 'Next real action', 'One unfinished action, the responsible person, and when to complete it.']
  ] }
] as const;
type Field = typeof SECTIONS[number]['fields'][number][0];
type Plan = { version: 1; updatedAt: string | null; phoneChecked: boolean; lastPracticeAt: string | null; fields: Record<Field, string> };
function blankPlan(): Plan {
  return { version: 1, updatedAt: null, phoneChecked: false, lastPracticeAt: null, fields: Object.fromEntries(SECTIONS.flatMap(section => section.fields.map(([key]) => [key, '']))) as Record<Field, string> };
}
function decodePlan(raw: string): Plan {
  if (raw.length > MAX_STORED) throw new Error('Stored plan exceeds this version’s size limit. It has not been overwritten.');
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || typeof value.phoneChecked !== 'boolean' || !value.fields || ![value.updatedAt, value.lastPracticeAt].every(date => date === null || (typeof date === 'string' && Number.isFinite(Date.parse(date)))) || SECTIONS.some(section => section.fields.some(([key]) => typeof value.fields[key] !== 'string' || value.fields[key].length > MAX_FIELD)) || Object.keys(value.fields).length !== SECTIONS.reduce((n, section) => n + section.fields.length, 0)) throw new Error('Stored plan is damaged or uses an unsupported format. It has not been overwritten.');
  return value as Plan;
}
function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
function download(content: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function offlinePlanHtml(plan: Plan, exportedAt: string) {
  const sections = SECTIONS.map(section => `<section><h2>${escapeHtml(section.title)}</h2>${section.fields.map(([key, label]) => `<h3>${escapeHtml(label)}</h3><p class="entry">${escapeHtml(plan.fields[key] || 'Not yet recorded')}</p>`).join('')}</section>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Private household alert plan — static offline copy</title><style>body{max-width:760px;margin:2rem auto;padding:0 1rem;color:#17252c;background:white;font:17px/1.55 system-ui,sans-serif}h1,h2,h3{line-height:1.2}h2{margin-top:2rem;border-top:1px solid #9aa;padding-top:1rem}h3{font-size:1rem}.entry{white-space:pre-wrap;overflow-wrap:anywhere}.notice{border:2px solid #17252c;padding:1rem}a{color:#174663;overflow-wrap:anywhere}@media print{body{margin:0;max-width:none;font-size:11pt}section{break-inside:auto}h2,h3{break-after:avoid}.entry{break-inside:avoid}}</style></head><body><h1>Your household alert plan</h1><p class="notice"><strong>STATIC PRIVATE PLAN · NOT A LIVE WARNING</strong><br>Includes personal entries. No alerts or automatic updates.</p><section><h2>Keep this for a radiation emergency</h2><p>Follow current official instructions for your area. Other hazards may require different actions.</p>${GUIDANCE.actions.map(([title, text]) => `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>`).join('')}<p>Sources: <a href="${GUIDANCE.url}">${GUIDANCE.url}</a> · <a href="https://www.cdc.gov/radiation-emergencies/response/get-inside.html">https://www.cdc.gov/radiation-emergencies/response/get-inside.html</a></p></section><p>Exported: ${escapeHtml(exportedAt)}<br>Last browser save: ${escapeHtml(plan.updatedAt || 'Not saved')}<br>Phone settings checked by user: ${plan.phoneChecked ? 'Yes — self-reported, not device-verified' : 'Not recorded'}<br>Last practice: ${escapeHtml(plan.lastPracticeAt || 'Not recorded')} — self-reported, not a safety guarantee.</p>${sections}<section><h2>Preparedness reference</h2>${GUIDANCE.items.map(([title, text]) => `<h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>`).join('')}<p>Source: <a href="${GUIDANCE.url}">${GUIDANCE.url}</a><br>Source updated: ${GUIDANCE.sourceUpdated}. Guidance reviewed: ${GUIDANCE.reviewed}. Links require internet; all guidance above is included in this file.</p></section></body></html>`;
}
const PRACTICE = [
  'Practice only: locate your phone emergency-alert settings and your local enrollment confirmation. Check your radio and backup power without sending any message.',
  'Practice only: identify your planned shelter and an accessible route. Check keys, entry hours, and an alternative. Do not simulate an emergency or enter restricted areas.',
  'Practice only: locate your printed contacts and describe your no-internet arrangement. Review school / care plans. No alert or contact message is sent by this page.'
];
export default function AlertPlan() {
  const [loaded, setLoaded] = useState(() => {
    let raw: string | null = null;
    try { raw = localStorage.getItem(STORAGE_KEY); return { plan: raw ? decodePlan(raw) : blankPlan(), raw, error: '' }; }
    catch (error) { return { plan: blankPlan(), raw, error: error instanceof SyntaxError ? 'Stored plan could not be read. It has not been overwritten.' : error instanceof Error ? error.message : 'Browser storage is unavailable.' }; }
  });
  const [plan, setPlan] = useState(loaded.plan);
  const [blocked, setBlocked] = useState(Boolean(loaded.error));
  const [error, setError] = useState(loaded.error);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [clearPending, setClearPending] = useState(false);
  const [practice, setPractice] = useState<number | null>(null);
  const [practiceChecked, setPracticeChecked] = useState(false);
  const practiceRef = useRef<HTMLDivElement>(null);
  const savedRaw = useRef(loaded.raw);
  useEffect(() => {
    const changed = (event: StorageEvent) => { if (event.key === STORAGE_KEY || event.key === null) { setClearPending(false); setBlocked(true); setError('The saved plan changed in another tab. Export your current entries before reloading; saving is blocked to avoid overwriting another copy.'); } };
    const leaving = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('storage', changed); window.addEventListener('beforeunload', leaving);
    return () => { window.removeEventListener('storage', changed); window.removeEventListener('beforeunload', leaving); };
  }, [dirty]);
  useEffect(() => { if (practice !== null) practiceRef.current?.focus(); }, [practice]);
  function update(next: Plan) { setPlan(next); setDirty(true); setMessage(''); setClearPending(false); }
  function save() {
    try {
      if (blocked || localStorage.getItem(STORAGE_KEY) !== savedRaw.current) { setBlocked(true); throw new Error('Stored plan changed or is unreadable. Export these entries before reloading; the stored copy was not overwritten.'); }
      const next = { ...plan, updatedAt: new Date().toISOString() }; const raw = JSON.stringify(next);
      if (raw.length > MAX_STORED) throw new Error('Plan is too large to save. Download your entries before shortening them.');
      localStorage.setItem(STORAGE_KEY, raw); savedRaw.current = raw; setPlan(next); setDirty(false); setClearPending(false); setError(''); setMessage('Saved in this browser only.');
    } catch (failure) { setError(failure instanceof Error ? `Not saved: ${failure.message}` : 'Not saved: browser storage failed. Download your current entries.'); }
  }
  function clear() {
    try {
      if (!clearPending || localStorage.getItem(STORAGE_KEY) !== savedRaw.current) {
        setClearPending(false); setBlocked(true);
        setError('The saved copy changed. Nothing was cleared. Export your visible entries, then reload to inspect the newer copy before clearing.');
        return;
      }
      localStorage.removeItem(STORAGE_KEY);
      const next = blankPlan();
      savedRaw.current = null; setLoaded({ plan: next, raw: null, error: '' }); setPlan(next);
      setBlocked(false); setDirty(false); setError(''); setMessage('Browser plan cleared. Previously downloaded and printed copies are unchanged.'); setClearPending(false); setPractice(null);
    } catch { setError('Could not clear browser storage. Your current entries remain visible.'); }
  }
  async function copyLink() {
    const url = `${window.location.origin}/plan`;
    try { await navigator.clipboard.writeText(url); setMessage('Copied the blank public plan link. No personal entries were included.'); }
    catch { setMessage(`Clipboard unavailable. The blank public link is ${url}`); }
  }
  return <main className="watch-page resident-plan">
    <header><p className="watch-eyebrow">PRIVATE HOUSEHOLD PREPAREDNESS</p><h1>Your alert plan</h1><p className="watch-lede">Set up official alerts, choose shelter, and keep a copy that works without internet.</p><p>This is preparation, not a claim that a catastrophe is imminent. Your completed actions are self-reported, not a safety guarantee.</p></header>
    <section className="watch-panel plan-immediate"><h2>Keep this for a radiation emergency</h2><p>Follow current official instructions for your area. Other hazards may require different actions.</p>{GUIDANCE.actions.map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}<p><SourceLink url={GUIDANCE.url}>Ready.gov radiation guidance</SourceLink> · <SourceLink url="https://www.cdc.gov/radiation-emergencies/response/get-inside.html">CDC guidance and household arrangements</SourceLink></p></section>
    <section className="watch-panel"><h2>Start with channels that can reach you</h2><p>Official phone alerts, local emergency management, and radio are primary channels. This site is supplementary: it does not wake a closed or locked device, enroll you, or send civil alerts. Existing aviation signup is not a nuclear-alert subscription.</p><p><SourceLink url="https://www.ready.gov/alerts">Official alert setup</SourceLink> · <SourceLink url="https://www.ready.gov/radiation">Ready.gov radiation preparedness</SourceLink> · <a href="/watch">View official notice coverage</a></p></section>
    <section className="watch-panel"><h2>Private to this browser — not encrypted</h2><p>Entries stay in this browser’s local storage only when you choose Save. They are not sent in requests, URLs, analytics, or public share links. Anyone using this browser profile may read them. Clearing browser data, private browsing, or storage eviction can remove the saved plan. Downloads and printouts also contain personal information.</p><p>Use a trusted device. Save after editing, then download or print a backup. Each field is limited to {MAX_FIELD} characters; one versioned plan is retained.</p>
      <div className="plan-actions"><button type="button" onClick={save} disabled={blocked}>Save in this browser</button><button type="button" onClick={() => download(offlinePlanHtml(plan, new Date().toISOString()), 'household-alert-plan.html', 'text/html;charset=utf-8')}>Download offline HTML</button><button type="button" onClick={() => window.print()}>Print plan</button><button type="button" onClick={copyLink}>Copy public plan link</button></div>
      <p role="status">{dirty ? 'Unsaved changes — save or download before leaving.' : plan.updatedAt ? <>Last browser save: <Clock value={plan.updatedAt} /></> : 'No plan saved yet.'} {message}</p>
      {error && <div className="watch-error" role="alert">{error} Your visible entries can still be downloaded. {loaded.raw && blocked && <button type="button" onClick={() => download(loaded.raw!, 'resident-plan-recovery.txt', 'text/plain;charset=utf-8')}>Download original stored data</button>}</div>}
    </section>
    {SECTIONS.map((section, index) => <section className="watch-panel" key={section.title}><h2>{section.title}</h2><div className="plan-fields">{section.fields.map(([key, label, hint]) => <label key={key} htmlFor={`plan-${key}`}><strong>{label}</strong><span id={`hint-${key}`} className="watch-muted">{hint}</span><textarea id={`plan-${key}`} aria-describedby={`hint-${key}`} rows={3} maxLength={MAX_FIELD} value={plan.fields[key]} autoComplete="off" spellCheck={false} onChange={event => update({ ...plan, fields: { ...plan.fields, [key]: event.target.value } })} /><span className="plan-print-entry">{plan.fields[key] || 'Not yet recorded'}</span></label>)}</div>{index === 0 && <label className="plan-check"><input type="checkbox" checked={plan.phoneChecked} onChange={event => update({ ...plan, phoneChecked: event.target.checked })} /> I checked my phone’s emergency-alert settings myself. This is not device verification.</label>}</section>)}
    <section className="watch-panel"><h2>Preparedness reference</h2>{GUIDANCE.items.map(([title, text]) => <div key={title}><h3>{title}</h3><p>{text}</p></div>)}<p>Sources: <SourceLink url={GUIDANCE.url}>{GUIDANCE.url}</SourceLink> · Source updated {GUIDANCE.sourceUpdated} · Guidance reviewed {GUIDANCE.reviewed}. <SourceLink url="https://www.weather.gov/wrn/wea">NWS: Wireless Emergency Alerts</SourceLink> · <SourceLink url="https://www.cdc.gov/radiation-emergencies/response/get-inside.html">CDC: get inside and household arrangements</SourceLink>.</p></section>
    <section className="watch-panel plan-practice"><h2>Practice only — no alert is sent</h2><p>Walk through your plan calmly. No permission prompts, emergency simulation, or contact messages. Last practice: <Clock value={plan.lastPracticeAt} /> (self-reported).</p>{practice === null ? <button type="button" onClick={() => { setPractice(0); setPracticeChecked(false); }}>Start guided practice</button> : <div ref={practiceRef} tabIndex={-1}><h3>Practice only · Step {practice + 1} of {PRACTICE.length}</h3><p>{PRACTICE[practice]}</p><label className="plan-check"><input type="checkbox" checked={practiceChecked} onChange={event => setPracticeChecked(event.target.checked)} /> I have personally reviewed this step.</label><div className="plan-actions"><button type="button" disabled={!practiceChecked} onClick={() => { if (practice === PRACTICE.length - 1) { update({ ...plan, lastPracticeAt: new Date().toISOString() }); setPractice(null); setMessage('Practice recorded in the current plan. Save to retain it; this is self-reported only.'); } else { setPractice(practice + 1); setPracticeChecked(false); } }}>{practice === PRACTICE.length - 1 ? 'Record self-reported practice' : 'Next practice step'}</button><button type="button" onClick={() => setPractice(null)}>End without recording</button></div></div>}</section>
    <section className="watch-panel plan-clear"><h2>Keep control of your copy</h2><p>Clearing removes this browser’s saved plan and the entries currently on screen. It cannot remove downloaded files or printouts.</p>{clearPending ? <><p>Download anything you want to keep before clearing.</p><button type="button" onClick={clear}>Yes, clear this browser plan</button> <button type="button" onClick={() => setClearPending(false)}>Keep plan</button></> : <button type="button" onClick={() => setClearPending(true)}>Clear this browser plan…</button>}</section>
  </main>;
}
