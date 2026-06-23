import { FormEvent, useEffect, useMemo, useState } from 'react';

const DASHBOARD_URLS = {
  business: import.meta.env.VITE_DASHBOARD_URL || '/dashboard.json',
  military: import.meta.env.VITE_MILITARY_DASHBOARD_URL || '/military-dashboard.json',
  untracked: import.meta.env.VITE_UNTRACKED_DASHBOARD_URL || '/untracked-dashboard.json',
} as const;

const CATEGORY_LABELS: Record<CohortKind, string> = {
  business: 'Business jets',
  military: 'Military',
  untracked: 'Untracked',
};

const HALF_HOUR_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const LEVEL_COUNT = 5;
const DEFAULT_ALARM_SIGMA = 4.8;

type CohortKind = 'business' | 'military' | 'untracked';

type DashboardResponse = {
  mode?: string;
  warning?: string | null;
  cohort?: {
    configured?: boolean;
    trackedCount?: number | null;
    sourceLabel?: string | null;
    cohortType?: string | null;
  };
  liveStatus?: {
    providerLabel?: string;
    cadenceMinutes?: number;
    lastSuccessAt?: string | null;
    latestSampledAt?: string | null;
    lastError?: string | null;
    matchedCount?: number | null;
    airborneCount?: number | null;
    concurrentCount?: number | null;
  };
  current?: CurrentSignal;
  signals?: {
    composite?: CompositeSignal;
  };
  liveAircraft?: Aircraft[];
  trends?: {
    archive?: PackedArchive | ArchivePoint[];
    holidayWindows?: HolidayWindow[];
  };
};

type CurrentSignal = {
  asOf?: string;
  concurrentCount?: number;
  baselineMean?: number;
  baselineStdDev?: number;
  effectiveBaselineStdDev?: number;
  zScore?: number;
  rawZScore?: number;
  varianceAdjustedZScore?: number;
  absoluteExcessWeight?: number;
  gaugeValue?: number;
  alertLevel?: string;
  emergencyLevel?: number;
  alarmSigmaThreshold?: number;
  elevatedSigmaThreshold?: number;
};

type CompositeSignal = {
  asOf?: string;
  actualConcurrentCount?: number;
  expectedConcurrentCount?: number;
  expectedConcurrentStdDev?: number;
  effectiveConcurrentStdDev?: number;
  rawSigmaShift?: number;
  varianceAdjustedSigmaShift?: number;
  absoluteExcessWeight?: number;
  sigmaShift?: number;
  emergencyLevel?: number;
  gaugeValue?: number;
  alarmSigmaThreshold?: number;
  concurrentPredictionModel?: string;
  weeklySampleCount?: number;
  timeOfWeekSampleCount?: number;
};

type PackedArchive = {
  v: 1;
  t0: string;
  tr?: [number, number][];
  c?: number[];
  p?: number[];
  s?: number[];
  z?: number[];
};

type ArchivePoint = {
  sampledAt?: string;
  concurrentCount?: number;
  predictedConcurrentCount?: number;
  predictedConcurrentStdDev?: number;
  divergence?: number;
  sigmaShift?: number;
  emergencyLevel?: number;
};

type HolidayWindow = {
  id?: string;
  label?: string;
  startsAt?: string;
  endsAt?: string;
};

type Aircraft = {
  hex?: string;
  registration?: string | null;
  label?: string | null;
  observed_at?: string;
  observedAt?: string;
  lat?: number;
  lon?: number;
  altitudeFt?: number | null;
  groundSpeedKt?: number | null;
  track?: number | null;
  isAirborne?: boolean;
  path?: Array<{ observedAt?: string; lat?: number; lon?: number }>;
  cohortKind?: CohortKind;
  ownerOperator?: string | null;
  markerId?: string;
};

type AlertEvent = {
  id: number;
  kind: string;
  severity: string;
  cohort: string;
  occurredAt: string;
  title: string;
  message: string;
  status: string;
};

type TakeoffEvent = {
  id: number;
  cohort: string;
  hex: string;
  registration?: string | null;
  label?: string | null;
  observedAt: string;
  altitudeFt?: number | null;
  groundSpeedKt?: number | null;
};

type LoadedDashboards = Partial<Record<CohortKind, DashboardResponse>>;
type SelectedCohorts = Record<CohortKind, boolean>;

type SignalMath = {
  divergence: number;
  sigmaShift: number;
  rawSigmaShift: number;
  varianceAdjustedSigmaShift: number;
  effectiveBaselineStdDev: number;
  absoluteExcessWeight: number;
  emergencyLevel: number;
};

type CombinedDashboard = {
  selectedKinds: CohortKind[];
  selectedLabels: string[];
  primary: DashboardResponse;
  liveAircraft: Aircraft[];
  archive: ArchivePoint[];
  holidayWindows: HolidayWindow[];
  trackedCount: number | null;
  actualCount: number;
  expectedCount: number;
  stdDev: number;
  alarmSigmaThreshold: number;
  signal: CurrentSignal & SignalMath;
  asOf?: string;
  providerStatus: string;
  modelCounts: ModelCount[];
  seats: SeatEstimate;
};

type ModelCount = {
  label: string;
  count: number;
  capacity: number | null;
  wiki?: string;
};

type SeatEstimate = {
  knownAircraftCount: number;
  totalAircraftCount: number;
  knownSeats: number;
  estimatedSeats: number | null;
};

function App() {
  const path = window.location.pathname;
  return path.startsWith('/signup') ? <SignupPage /> : <DashboardPage />;
}

function DashboardPage() {
  const [dashboards, setDashboards] = useState<LoadedDashboards>({});
  const [selected, setSelected] = useState<SelectedCohorts>({ business: true, military: false, untracked: false });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [emergencyTheme, setEmergencyTheme] = useState(false);
  const [alertEvents, setAlertEvents] = useState<AlertEvent[]>([]);
  const [takeoffEvents, setTakeoffEvents] = useState<TakeoffEvent[]>([]);
  const [operationsError, setOperationsError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('emergency-color-scheme', emergencyTheme);
  }, [emergencyTheme]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setStatus((current) => (current === 'ready' ? 'ready' : 'loading'));
      setError(null);
      try {
        const entries = await Promise.all(
          (Object.entries(DASHBOARD_URLS) as Array<[CohortKind, string]>).map(async ([kind, baseUrl]) => {
            const url = `${baseUrl}?v=${Math.floor(Date.now() / 300000)}`;
            const response = await fetch(url, { cache: 'no-store' });
            const contentType = response.headers.get('content-type') ?? '';
            const text = await response.text();
            if (!response.ok) {
              throw new Error(`${CATEGORY_LABELS[kind]} request failed with ${response.status} ${response.statusText}`);
            }
            if (!contentType.includes('json')) {
              throw new Error(`${CATEGORY_LABELS[kind]} returned ${contentType || 'an unknown content type'}`);
            }
            return [kind, JSON.parse(text) as DashboardResponse] as const;
          }),
        );
        if (cancelled) return;
        setDashboards(Object.fromEntries(entries) as LoadedDashboards);
        setLastFetchedAt(new Date().toISOString());
        setStatus('ready');
      } catch (loadError) {
        if (cancelled) return;
        setStatus('error');
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }

    load();
    const interval = window.setInterval(load, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadOperations() {
      setOperationsError(null);
      try {
        const [alertsResponse, takeoffsResponse] = await Promise.all([
          fetch('/api/alerts?limit=8', { cache: 'no-store' }),
          fetch('/api/takeoffs?limit=8', { cache: 'no-store' }),
        ]);
        if (!alertsResponse.ok) throw new Error(`Alert event request failed with ${alertsResponse.status}`);
        if (!takeoffsResponse.ok) throw new Error(`Takeoff event request failed with ${takeoffsResponse.status}`);
        const [alertsPayload, takeoffsPayload] = await Promise.all([alertsResponse.json(), takeoffsResponse.json()]);
        if (cancelled) return;
        setAlertEvents(Array.isArray(alertsPayload.events) ? alertsPayload.events : []);
        setTakeoffEvents(Array.isArray(takeoffsPayload.events) ? takeoffsPayload.events : []);
      } catch (loadError) {
        if (cancelled) return;
        setOperationsError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    }

    loadOperations();
    const interval = window.setInterval(loadOperations, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const combined = useMemo(() => combineDashboards(dashboards, selected), [dashboards, selected]);

  function toggleKind(kind: CohortKind) {
    setSelected((current) => {
      const next = { ...current, [kind]: !current[kind] };
      if (!Object.values(next).some(Boolean)) return current;
      return next;
    });
  }

  if (status === 'loading' && !combined) {
    return <StatusPage title="Loading dashboard" detail="Fetching live aircraft anomaly snapshots." />;
  }

  if (status === 'error' && !combined) {
    return <StatusPage title="Dashboard unavailable" detail={error ?? 'The dashboard data request failed.'} tone="error" />;
  }

  if (!combined) {
    return <StatusPage title="No cohort selected" detail="Select at least one aircraft category." tone="error" />;
  }

  return (
    <main className="app-shell">
      <div className="background-wallpaper" aria-hidden="true" />
      <p className="signup-teaser">
        <a href="/signup">Sign up</a> for text message or email notifications.
      </p>

      {error ? <div className="status-banner status-banner-error"><strong>Refresh error:</strong> {error}</div> : null}

      <section className="focus-grid">
        <HeroPanel />
        <DialPanel combined={combined} onEmergencyLevelTap={() => setEmergencyTheme((value) => !value)} />
      </section>

      <ProviderPanel combined={combined} lastFetchedAt={lastFetchedAt} />

      <section className="top-grid">
        <RealtimeMap aircraft={combined.liveAircraft} />
        <ArchivePanel combined={combined} selected={selected} onToggle={toggleKind} />
      </section>

      <section className="secondary-grid">
        <ModelList models={combined.modelCounts} />
        <OperationsPanel alerts={alertEvents} takeoffs={takeoffEvents} error={operationsError} />
      </section>

      <AboutPanel selectedLabels={combined.selectedLabels} />
      <FaqPanel />
      <UpdatesPanel />
    </main>
  );
}

function StatusPage({ title, detail, tone = 'normal' }: { title: string; detail: string; tone?: 'normal' | 'error' }) {
  return (
    <main className="app-shell">
      <section className={`panel loading-panel ${tone === 'error' ? 'error-panel' : ''}`}>
        <h1>{title}</h1>
        <p>{detail}</p>
      </section>
    </main>
  );
}

function HeroPanel() {
  return (
    <section className="panel hero-copy-panel">
      <h1>Apocalypse Early Warning System</h1>
      <p>
        A local recreation of the public aircraft-anomaly dashboard. It watches selected aircraft cohorts and asks whether the
        number currently airborne is unusual for the same time window in the historical archive.
      </p>
      <p>
        The emergency level is a 1–5 signal: level 1 means ordinary traffic; level 5 means the selected cohort is far beyond its
        calibrated historical envelope.
      </p>
      <p className="hero-credit">independent implementation from observed behavior</p>
      <p className="hero-link-row">
        <a href="https://ews.kylemcdonald.net/">Reference site</a> / <a href="https://t.me/apocalypse_ews">Telegram</a> /{' '}
        <a href="https://ews.kylemcdonald.net/rss.xml">RSS</a>
      </p>
    </section>
  );
}

function DialPanel({ combined, onEmergencyLevelTap }: { combined: CombinedDashboard; onEmergencyLevelTap: () => void }) {
  const level = clampLevel(combined.signal.emergencyLevel);
  const trackedCopy = combined.trackedCount == null ? 'unknown cohort size' : `${formatInteger(combined.trackedCount)} tracked`;
  const seatCopy = combined.seats.estimatedSeats == null ? 'seat estimate unavailable' : `${formatInteger(combined.seats.estimatedSeats)} max seats airborne`;
  const sigma = combined.signal.sigmaShift;
  const deviation = combined.actualCount - combined.expectedCount;

  return (
    <section className={`panel dial-panel emergency-level-${level}`}>
      <div className="panel-header">
        <h2>
          <button type="button" className="emergency-level-trigger" aria-label={`Emergency level ${level} of 5`} onClick={onEmergencyLevelTap}>
            Emergency level {level}/5
          </button>
        </h2>
      </div>
      <div className="summary-text-block">
        <p className="summary-count-line">
          <strong>{formatInteger(combined.actualCount)}</strong> / {trackedCopy} planes airborne
        </p>
        <p className="summary-count-line">
          <strong>{seatCopy}</strong>
        </p>
        <p>
          Deviation: <strong>{formatSigned(deviation)}</strong> ({formatSigned(sigma, 1)}σ)
        </p>
        <p>Expected: {formatNumber(combined.expectedCount, 1)} aircraft, σ floor {formatNumber(combined.signal.effectiveBaselineStdDev, 1)}</p>
        <p>Last update: {formatDateTime(combined.asOf)}</p>
      </div>
    </section>
  );
}

function ProviderPanel({ combined, lastFetchedAt }: { combined: CombinedDashboard; lastFetchedAt: string | null }) {
  return (
    <section className="panel provider-panel">
      <div className="panel-header">
        <div>
          <h2>Realtime Tracker</h2>
          <p className="panel-lede">{combined.providerStatus}</p>
        </div>
        <span className="map-badge">{combined.selectedLabels.join(' + ')}</span>
      </div>
      <p className="panel-footnote">Browser refresh: {formatDateTime(lastFetchedAt)}</p>
    </section>
  );
}

function ArchivePanel({ combined, selected, onToggle }: { combined: CombinedDashboard; selected: SelectedCohorts; onToggle: (kind: CohortKind) => void }) {
  const [windowDays, setWindowDays] = useState(3);
  const [offsetDays, setOffsetDays] = useState(0);
  const archive = combined.archive;
  const latestTime = Date.parse(archive.at(-1)?.sampledAt ?? '');
  const earliestTime = Date.parse(archive[0]?.sampledAt ?? '');
  const totalDays = Number.isFinite(latestTime) && Number.isFinite(earliestTime) ? Math.max(1, Math.ceil((latestTime - earliestTime) / DAY_MS)) : 1;
  const maxOffset = Math.max(0, totalDays - windowDays);
  const safeOffset = Math.min(offsetDays, maxOffset);
  const endTime = Number.isFinite(latestTime) ? latestTime - safeOffset * DAY_MS : Date.now();
  const startTime = endTime - windowDays * DAY_MS;
  const visible = archive.filter((point) => {
    const time = Date.parse(point.sampledAt ?? '');
    return Number.isFinite(time) && time >= startTime && time <= endTime;
  });
  const levels = visible.map((point) => ({ ...point, emergencyLevel: pointToEmergencyLevel(point, combined.alarmSigmaThreshold) }));

  function changeWindow(days: number) {
    setWindowDays(days);
    setOffsetDays((current) => Math.min(current, Math.max(0, totalDays - days)));
  }

  return (
    <section className="panel chart-panel history-panel">
      <div className="panel-header">
        <h2>Traffic Archive</h2>
      </div>
      <div className="chart-toolbar">
        <div className="chart-range-copy">
          <strong>{formatShortDate(visible[0]?.sampledAt)} to {formatShortDate(visible.at(-1)?.sampledAt)}</strong>
          <span>{archive.length ? `${formatInteger(archive.length)} half-hour samples decoded` : 'No archive samples available'}</span>
        </div>
      </div>
      <div className="chart-range-toolbar">
        <label className="chart-slider-label">
          <span>Archive position</span>
          <input
            className="chart-range-slider"
            type="range"
            min={0}
            max={maxOffset}
            value={maxOffset - safeOffset}
            aria-label="Archive position"
            onChange={(event) => setOffsetDays(maxOffset - Number(event.currentTarget.value))}
          />
        </label>
      </div>
      <fieldset className="chart-radio-group">
        <legend>Historical archive window</legend>
        {[3, 7, 30].map((days) => (
          <label key={days} className="chart-radio-option">
            <input type="radio" name="archive-window" checked={windowDays === days} onChange={() => changeWindow(days)} />
            {days === 30 ? '1 month' : `${days} days`}
          </label>
        ))}
      </fieldset>
      <fieldset className="chart-checkbox-group cohort-toggle-group">
        <legend>Aircraft categories</legend>
        {(Object.keys(CATEGORY_LABELS) as CohortKind[]).map((kind) => (
          <label key={kind} className={`chart-checkbox-option cohort-toggle-option ${selected[kind] ? 'cohort-toggle-option-active' : ''}`}>
            <input type="checkbox" checked={selected[kind]} onChange={() => onToggle(kind)} />
            {CATEGORY_LABELS[kind]}
          </label>
        ))}
      </fieldset>
      <LineChart
        title="Aircraft count history"
        data={visible}
        lines={[
          { key: 'concurrentCount', label: 'Airborne', color: '#0000ee' },
          { key: 'predictedConcurrentCount', label: 'Expected', color: '#666666' },
        ]}
        height={260}
      />
      <LineChart
        title="Historical Emergency Level"
        data={levels}
        lines={[{ key: 'emergencyLevel', label: 'Emergency level', color: '#cc0000' }]}
        minY={1}
        maxY={5}
        height={170}
      />
    </section>
  );
}

function LineChart({
  title,
  data,
  lines,
  minY,
  maxY,
  height,
}: {
  title: string;
  data: ArchivePoint[];
  lines: Array<{ key: keyof ArchivePoint; label: string; color: string }>;
  minY?: number;
  maxY?: number;
  height: number;
}) {
  const width = 860;
  const padding = { left: 54, right: 22, top: 18, bottom: 34 };
  const drawableWidth = width - padding.left - padding.right;
  const drawableHeight = height - padding.top - padding.bottom;
  const values = data.flatMap((point) => lines.map((line) => Number(point[line.key])).filter(Number.isFinite));
  const yMin = minY ?? Math.min(0, ...values);
  const yMax = maxY ?? Math.max(1, ...values);
  const ySpan = Math.max(1, yMax - yMin);
  const x = (index: number) => padding.left + (data.length <= 1 ? 0 : (index / (data.length - 1)) * drawableWidth);
  const y = (value: number) => padding.top + drawableHeight - ((value - yMin) / ySpan) * drawableHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => yMin + (index / 4) * ySpan);
  const xTicks = makeDateTicks(data, 4);

  return (
    <div className="chart-frame">
      <div className="chart-subsection-header">
        <strong>{title}</strong>
        <span>{lines.map((line) => line.label).join(' / ')}</span>
      </div>
      <svg className="archive-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        <rect x={0} y={0} width={width} height={height} fill="transparent" />
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={padding.left} x2={width - padding.right} y1={y(tick)} y2={y(tick)} stroke="#d4d4d4" strokeWidth="1" />
            <text x={padding.left - 10} y={y(tick) + 4} textAnchor="end">{formatAxis(tick)}</text>
          </g>
        ))}
        {xTicks.map(({ label, index }) => (
          <text key={`${label}-${index}`} x={x(index)} y={height - 10} textAnchor="middle">{label}</text>
        ))}
        {lines.map((line) => {
          const path = data
            .map((point, index) => {
              const value = Number(point[line.key]);
              if (!Number.isFinite(value)) return null;
              return `${index === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`;
            })
            .filter(Boolean)
            .join(' ');
          return <path key={line.key} d={path} fill="none" stroke={line.color} strokeWidth="2" vectorEffect="non-scaling-stroke" />;
        })}
      </svg>
    </div>
  );
}

function RealtimeMap({ aircraft }: { aircraft: Aircraft[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const validAircraft = aircraft.filter((plane) => isFiniteCoordinate(plane.lat, plane.lon));
  const active = validAircraft.find((plane) => plane.markerId === activeId) ?? validAircraft[0];
  const width = 840;
  const height = 430;

  return (
    <section className="panel map-panel">
      <div className="panel-header">
        <h2>Realtime Tracker</h2>
        <span className="map-badge">{formatInteger(validAircraft.length)} mapped</span>
      </div>
      <div className="map-frame">
        <div className="map-controls" aria-label="Map controls">
          <button type="button" className="map-control-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value * 1.5))}>+</button>
          <button type="button" className="map-control-button" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => setZoom((value) => Math.max(1, value / 1.5))}>−</button>
        </div>
        {active ? <AircraftHoverCard aircraft={active} /> : null}
        <svg className="map-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Live aircraft map">
          <rect className="map-sphere" x="1" y="1" width={width - 2} height={height - 2} rx="0" />
          {Array.from({ length: 11 }, (_, index) => -150 + index * 30).map((lon) => (
            <line key={`lon-${lon}`} className="map-graticule" x1={project(lon, -90, width, height).x} y1="0" x2={project(lon, 90, width, height).x} y2={height} />
          ))}
          {Array.from({ length: 7 }, (_, index) => -60 + index * 20).map((lat) => (
            <line key={`lat-${lat}`} className="map-graticule" x1="0" y1={project(0, lat, width, height).y} x2={width} y2={project(0, lat, width, height).y} />
          ))}
          <g transform={`translate(${width / 2} ${height / 2}) scale(${zoom}) translate(${-width / 2} ${-height / 2})`}>
            {validAircraft.map((plane, index) => {
              const { x, y } = project(plane.lon!, plane.lat!, width, height);
              const id = plane.markerId ?? `${plane.hex}-${index}`;
              const activeMarker = id === activeId;
              return (
                <g
                  key={id}
                  className={`map-marker map-marker-${plane.cohortKind ?? 'business'} ${activeMarker ? 'map-marker-active' : ''}`}
                  transform={`translate(${x.toFixed(2)} ${y.toFixed(2)})`}
                  tabIndex={0}
                  role="button"
                  aria-label={plane.label ?? plane.hex ?? 'Aircraft'}
                  onMouseEnter={() => setActiveId(id)}
                  onFocus={() => setActiveId(id)}
                  onClick={() => setActiveId(id)}
                >
                  <circle className="map-marker-halo" r="10" />
                  <path className="map-marker-plane" d="M0 -8 L5 6 L0 3 L-5 6 Z" />
                  <circle className="map-marker-hit" r="14" />
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </section>
  );
}

function AircraftHoverCard({ aircraft }: { aircraft: Aircraft }) {
  return (
    <aside className="map-hover-card">
      <div className="map-hover-header">
        <strong>{aircraft.label || aircraft.registration || aircraft.hex || 'Unknown aircraft'}</strong>
        <span>{CATEGORY_LABELS[aircraft.cohortKind ?? 'business']}</span>
      </div>
      <dl className="map-hover-grid">
        <div>
          <dt>Hex</dt>
          <dd>{aircraft.hex ?? '—'}</dd>
        </div>
        <div>
          <dt>Registration</dt>
          <dd>{aircraft.registration ?? '—'}</dd>
        </div>
        <div>
          <dt>Altitude</dt>
          <dd>{formatNullableNumber(aircraft.altitudeFt, 0)} ft</dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{formatNullableNumber(aircraft.groundSpeedKt, 1)} kt</dd>
        </div>
        <div className="map-hover-coordinates">
          <dt>Owner / operator</dt>
          <dd>{aircraft.ownerOperator ?? '—'}</dd>
        </div>
        <div className="map-hover-coordinates">
          <dt>Observed</dt>
          <dd>{formatDateTime(aircraft.observed_at ?? aircraft.observedAt)}</dd>
        </div>
      </dl>
    </aside>
  );
}

function ModelList({ models }: { models: ModelCount[] }) {
  const visible = models.slice(0, 140);
  return (
    <section className="panel list-panel">
      <div className="panel-header">
        <h2>Aircraft By Model</h2>
        <span className="map-badge">{formatInteger(models.length)} types</span>
      </div>
      {visible.length ? (
        <ol className="flight-list model-list">
          {visible.map((model) => (
            <li key={model.label}>
              <div className="model-name-cell">
                <div className="model-title-row">
                  {model.wiki ? <a className="model-wiki-link" href={model.wiki}><strong>{model.label}</strong></a> : <strong>{model.label}</strong>}
                  {model.capacity ? <span className="model-passenger-label">{model.capacity}</span> : null}
                </div>
              </div>
              <span className="model-count">{formatInteger(model.count)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty-state">No aircraft are currently mapped for the selected cohorts.</p>
      )}
    </section>
  );
}

function OperationsPanel({ alerts, takeoffs, error }: { alerts: AlertEvent[]; takeoffs: TakeoffEvent[]; error: string | null }) {
  return (
    <section className="panel operations-panel">
      <div className="panel-header">
        <h2>Alert Operations</h2>
        <span className="map-badge">{formatInteger(alerts.length)} queued</span>
      </div>
      {error ? <p className="signup-status signup-status-error">{error}</p> : null}
      <div className="operations-grid">
        <div>
          <h3>Recent alert events</h3>
          {alerts.length ? (
            <ol className="ops-list">
              {alerts.map((alert) => (
                <li key={alert.id}>
                  <strong>{alert.title}</strong>
                  <span>{alert.kind} · {alert.severity} · {alert.status}</span>
                  <time>{formatDateTime(alert.occurredAt)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-state">No alert events have been queued yet.</p>
          )}
        </div>
        <div>
          <h3>Recent takeoff detections</h3>
          {takeoffs.length ? (
            <ol className="ops-list">
              {takeoffs.map((takeoff) => (
                <li key={takeoff.id}>
                  <strong>{takeoff.label || takeoff.registration || takeoff.hex}</strong>
                  <span>{takeoff.cohort} · {formatNullableNumber(takeoff.altitudeFt, 0)} ft · {formatNullableNumber(takeoff.groundSpeedKt, 0)} kt</span>
                  <time>{formatDateTime(takeoff.observedAt)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="empty-state">No takeoff transitions have been recorded for the current refresh window.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function AboutPanel({ selectedLabels }: { selectedLabels: string[] }) {
  return (
    <section className="panel about-panel">
      <h2>How This Works</h2>
      <div className="about-copy">
        <p>
          This app loads the public dashboard snapshots for {selectedLabels.join(' + ')} and recomputes the same client-side
          view: current concurrent aircraft, expected baseline, anomaly sigma, emergency level, archive chart, live map, and model
          counts.
        </p>
        <p>
          Data comes from public ADS-B Exchange heatmap-derived snapshots. The archive is packed as a half-hour time series; this
          implementation decodes it in the browser and intersects timestamps when multiple cohorts are selected.
        </p>
        <p>
          The seat estimate is a maximum-capacity approximation from model labels. It is not a manifest and does not identify who
          is onboard.
        </p>
      </div>
    </section>
  );
}

function FaqPanel() {
  return (
    <section className="panel faq-panel">
      <h2>FAQ</h2>
      <div className="faq-list">
        <article>
          <h3>Is this trying to detect missiles already inbound?</h3>
          <p>No. The signal is earlier behavioral change: unusual aircraft activity before public information catches up.</p>
        </article>
        <article>
          <h3>What counts as a business jet here?</h3>
          <p>The reference dataset uses public aircraft metadata keyed by ICAO hex and filters for known business-jet families.</p>
        </article>
        <article>
          <h3>Does level 5 prove an apocalypse is likely?</h3>
          <p>No. It means the selected public flight signal is historically extreme. It is an anomaly monitor, not proof of motive.</p>
        </article>
      </div>
    </section>
  );
}

function UpdatesPanel() {
  return (
    <section className="panel updates-panel">
      <h2>Updates</h2>
      <div className="updates-copy">
        <article className="update-entry">
          <h3>Clone notes</h3>
          <p>Independent React/Vite implementation. Public JSON snapshots are loaded directly; no source code or assets from the reference repository are vendored.</p>
        </article>
      </div>
    </section>
  );
}

function SignupPage() {
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setStatus(null);
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    if (!trimmedEmail && !trimmedPhone) {
      setError('Enter an email address, a phone number, or both before submitting.');
      return;
    }
    if (trimmedEmail && !/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
      setError('Enter a valid email address.');
      return;
    }
    if (trimmedPhone && !/^\+?[0-9][0-9\s().-]{6,}$/.test(trimmedPhone)) {
      setError('Enter a phone number with country code if SMS alerts are desired.');
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/notifications/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: trimmedEmail || null, phone: trimmedPhone || null }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || `Signup failed with HTTP ${response.status}`);
      }
      window.localStorage.setItem(
        'ews-notification-request',
        JSON.stringify({ email: trimmedEmail || null, phone: trimmedPhone || null, createdAt: new Date().toISOString() }),
      );
      setStatus('Notification subscription saved on the backend. You will receive queued takeoff and anomaly alerts when delivery credentials are configured.');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Notification signup failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="app-shell signup-shell">
      <div className="background-wallpaper" aria-hidden="true" />
      <section className="focus-grid signup-grid">
        <section className="panel hero-copy-panel signup-copy-panel">
          <h1>Apocalypse Notifications</h1>
          <p>Get notified when the emergency level reaches 5. Production deployments should connect this form to checkout, email, and SMS delivery services.</p>
          <p>Contact info should be used only for alerts and subscription updates, not marketing.</p>
          <p className="hero-link-row"><a href="/">Back to Dashboard</a></p>
        </section>
        <section className="panel signup-panel">
          <h2>Notification Signup</h2>
          {error ? <p className="signup-status signup-status-error">{error}</p> : null}
          {status ? <p className="signup-status signup-status-success">{status}</p> : null}
          <form className="signup-form" onSubmit={submit} noValidate>
            <label className="signup-field">
              <span>Email address</span>
              <input type="email" name="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.currentTarget.value)} />
            </label>
            <label className="signup-field">
              <span>Phone number</span>
              <input type="tel" name="phone" placeholder="+1 415 555 2671" value={phone} onChange={(event) => setPhone(event.currentTarget.value)} />
            </label>
            <button className="signup-submit" type="submit" disabled={submitting}>{submitting ? 'Saving...' : 'Sign Up'}</button>
          </form>
        </section>
      </section>
    </main>
  );
}

function combineDashboards(dashboards: LoadedDashboards, selected: SelectedCohorts): CombinedDashboard | null {
  const entries = (Object.keys(CATEGORY_LABELS) as CohortKind[])
    .filter((kind) => selected[kind] && dashboards[kind])
    .map((kind) => ({ kind, dashboard: dashboards[kind]! }));

  if (!entries.length) return null;

  const selectedLabels = entries.map((entry) => CATEGORY_LABELS[entry.kind]);
  const liveAircraft = entries.flatMap((entry) =>
    (entry.dashboard.liveAircraft ?? []).map((aircraft, index) => ({
      ...aircraft,
      cohortKind: entry.kind,
      markerId: `${entry.kind}:${aircraft.hex ?? aircraft.registration ?? aircraft.label ?? index}`,
    })),
  );
  const archives = entries.map((entry) => decodeArchive(entry.dashboard.trends?.archive));
  const archive = entries.length === 1 ? archives[0] : combineArchives(archives);
  const trackedCounts = entries.map((entry) => entry.dashboard.cohort?.trackedCount).filter((value): value is number => Number.isFinite(value));
  const trackedCount = trackedCounts.length === entries.length ? trackedCounts.reduce((sum, value) => sum + value, 0) : null;

  const actualCount = entries.reduce((sum, entry) => sum + finiteNumber(entry.dashboard.current?.concurrentCount ?? entry.dashboard.signals?.composite?.actualConcurrentCount, 0), 0);
  const expectedCount = entries.reduce((sum, entry) => sum + finiteNumber(entry.dashboard.current?.baselineMean ?? entry.dashboard.signals?.composite?.expectedConcurrentCount, 0), 0);
  const stdDev = Math.sqrt(entries.reduce((sum, entry) => {
    const value = finiteNumber(entry.dashboard.current?.baselineStdDev ?? entry.dashboard.signals?.composite?.expectedConcurrentStdDev, 0);
    return sum + value * value;
  }, 0));

  const archiveScale = archiveDistribution(archive);
  const alarmSigmaThreshold = entries.length === 1
    ? finiteNumber(entries[0].dashboard.current?.alarmSigmaThreshold ?? entries[0].dashboard.signals?.composite?.alarmSigmaThreshold, DEFAULT_ALARM_SIGMA)
    : calibrateAlarmThreshold(archive);
  const computed = computeSignal(actualCount, expectedCount, stdDev, alarmSigmaThreshold, archiveScale);
  const singleCurrent = entries.length === 1 ? entries[0].dashboard.current : undefined;
  const signal: CurrentSignal & SignalMath = {
    ...(singleCurrent ?? {}),
    ...computed,
    concurrentCount: actualCount,
    baselineMean: expectedCount,
    baselineStdDev: stdDev,
    effectiveBaselineStdDev: computed.effectiveBaselineStdDev,
    zScore: computed.sigmaShift,
    rawZScore: computed.rawSigmaShift,
    varianceAdjustedZScore: computed.varianceAdjustedSigmaShift,
    emergencyLevel: computed.emergencyLevel,
    alarmSigmaThreshold,
  };

  const primary = entries[0].dashboard;
  const asOf = entries.map((entry) => entry.dashboard.current?.asOf ?? entry.dashboard.liveStatus?.latestSampledAt).filter((value): value is string => typeof value === 'string' && value.length > 0).sort().at(-1);
  const holidayWindows = dedupeHolidayWindows(entries.flatMap((entry) => entry.dashboard.trends?.holidayWindows ?? []));
  const providerStatus = entries.map((entry) => {
    const live = entry.dashboard.liveStatus;
    const last = live?.lastSuccessAt ? formatDateTime(live.lastSuccessAt) : 'not reported';
    const matched = live?.matchedCount == null ? 'unknown matches' : `${formatInteger(live.matchedCount)} matches`;
    return `${CATEGORY_LABELS[entry.kind]}: ${live?.providerLabel ?? 'provider unknown'}, ${matched}, last success ${last}`;
  }).join(' · ');

  return {
    selectedKinds: entries.map((entry) => entry.kind),
    selectedLabels,
    primary,
    liveAircraft,
    archive: decorateArchiveLevels(archive, alarmSigmaThreshold),
    holidayWindows,
    trackedCount,
    actualCount,
    expectedCount,
    stdDev,
    alarmSigmaThreshold,
    signal,
    asOf,
    providerStatus,
    modelCounts: countModels(liveAircraft),
    seats: estimateSeats(liveAircraft),
  };
}

function decodeArchive(input: PackedArchive | ArchivePoint[] | undefined): ArchivePoint[] {
  if (Array.isArray(input)) return input.map(normalizeArchivePoint);
  if (!input || input.v !== 1 || !Array.isArray(input.c)) return [];
  const sampledAt = expandTimes(input.t0, input.tr);
  const length = Math.max(sampledAt.length, input.c.length, input.p?.length ?? 0, input.s?.length ?? 0, input.z?.length ?? 0);
  return Array.from({ length }, (_, index) => normalizeArchivePoint({
    sampledAt: sampledAt[index],
    concurrentCount: input.c?.[index],
    predictedConcurrentCount: input.p?.[index],
    predictedConcurrentStdDev: input.s?.[index],
    sigmaShift: input.z?.[index],
  }));
}

function expandTimes(t0: string, transitions: [number, number][] | undefined): string[] {
  const start = Date.parse(t0);
  if (!Number.isFinite(start)) return [];
  const result = [new Date(start).toISOString()];
  let current = start;
  for (const transition of transitions ?? []) {
    const [deltaMs, repeatCount] = transition;
    for (let index = 0; index < repeatCount; index += 1) {
      current += deltaMs;
      result.push(new Date(current).toISOString());
    }
  }
  return result;
}

function normalizeArchivePoint(point: ArchivePoint): ArchivePoint {
  const concurrentCount = finiteNumber(point.concurrentCount, 0);
  const predictedConcurrentCount = finiteNumber(point.predictedConcurrentCount, 0);
  const predictedConcurrentStdDev = finiteNumber(point.predictedConcurrentStdDev, 0);
  const divergence = finiteNumber(point.divergence, concurrentCount - predictedConcurrentCount);
  const sigmaShift = finiteNumber(point.sigmaShift, predictedConcurrentStdDev ? divergence / predictedConcurrentStdDev : 0);
  return { ...point, concurrentCount, predictedConcurrentCount, predictedConcurrentStdDev, divergence, sigmaShift };
}

function combineArchives(archives: ArchivePoint[][]): ArchivePoint[] {
  if (!archives.length || archives.some((archive) => archive.length === 0)) return [];
  const maps = archives.map((archive) => new Map(archive.map((point) => [roundSlot(point.sampledAt), point]).filter(([key]) => key) as Array<[string, ArchivePoint]>));
  return Array.from(maps[0].keys())
    .filter((key) => maps.every((map) => map.has(key)))
    .sort((a, b) => Date.parse(a) - Date.parse(b))
    .map((sampledAt) => {
      const points = maps.map((map) => map.get(sampledAt)!);
      const concurrentCount = points.reduce((sum, point) => sum + finiteNumber(point.concurrentCount, 0), 0);
      const predictedConcurrentCount = points.reduce((sum, point) => sum + finiteNumber(point.predictedConcurrentCount, 0), 0);
      const predictedConcurrentStdDev = Math.sqrt(points.reduce((sum, point) => sum + finiteNumber(point.predictedConcurrentStdDev, 0) ** 2, 0));
      return normalizeArchivePoint({ sampledAt, concurrentCount, predictedConcurrentCount, predictedConcurrentStdDev });
    });
}

function roundSlot(sampledAt: string | undefined): string | null {
  const time = Date.parse(sampledAt ?? '');
  if (!Number.isFinite(time)) return null;
  return new Date(Math.round(time / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

function archiveDistribution(points: ArchivePoint[]) {
  const divergences: number[] = [];
  const positiveDivergences: number[] = [];
  const stdDevs: number[] = [];
  for (const point of points) {
    const divergence = finiteNumber(point.concurrentCount, 0) - finiteNumber(point.predictedConcurrentCount, 0);
    const stdDev = finiteNumber(point.predictedConcurrentStdDev, 0);
    if (Number.isFinite(divergence)) {
      divergences.push(Math.abs(divergence));
      if (divergence > 0) positiveDivergences.push(divergence);
    }
    if (stdDev > 0) stdDevs.push(stdDev);
  }
  const stdDevFloor = median(divergences.filter((value) => value > 0)) ?? median(stdDevs) ?? 0;
  return { stdDevFloor, positiveExcessScale: median(positiveDivergences) ?? stdDevFloor };
}

function computeSignal(actual: number, expected: number, stdDev: number, alarmSigmaThreshold: number, scale: { stdDevFloor?: number; positiveExcessScale?: number }): SignalMath {
  const divergence = actual - expected;
  const effectiveBaselineStdDev = Math.max(stdDev, finiteNumber(scale.stdDevFloor, 0));
  if (!effectiveBaselineStdDev) {
    return { divergence, sigmaShift: 0, rawSigmaShift: 0, varianceAdjustedSigmaShift: 0, effectiveBaselineStdDev: 0, absoluteExcessWeight: 1, emergencyLevel: 1 };
  }
  const rawSigmaShift = stdDev ? divergence / stdDev : 0;
  const varianceAdjustedSigmaShift = divergence / effectiveBaselineStdDev;
  const positiveExcessScale = finiteNumber(scale.positiveExcessScale, 0);
  const absoluteExcessWeight = divergence > 0 && positiveExcessScale > 0 ? divergence / (divergence + positiveExcessScale) : 1;
  const sigmaShift = varianceAdjustedSigmaShift > 0 ? varianceAdjustedSigmaShift * absoluteExcessWeight : varianceAdjustedSigmaShift;
  const emergencyLevel = Math.min(LEVEL_COUNT, Math.max(1, Math.floor((Math.max(0, sigmaShift) / Math.max(1, alarmSigmaThreshold)) * (LEVEL_COUNT - 1)) + 1));
  return { divergence, sigmaShift, rawSigmaShift, varianceAdjustedSigmaShift, effectiveBaselineStdDev, absoluteExcessWeight, emergencyLevel };
}

function decorateArchiveLevels(points: ArchivePoint[], threshold: number): ArchivePoint[] {
  return points.map((point) => ({ ...point, emergencyLevel: pointToEmergencyLevel(point, threshold) }));
}

function pointToEmergencyLevel(point: ArchivePoint, threshold: number): number {
  const sigma = finiteNumber(point.sigmaShift, 0);
  return Math.min(LEVEL_COUNT, Math.max(1, Math.floor((Math.max(0, sigma) / Math.max(1, threshold)) * (LEVEL_COUNT - 1)) + 1));
}

function calibrateAlarmThreshold(points: ArchivePoint[]): number {
  if (!points.length) return DEFAULT_ALARM_SIGMA;
  const cutoff = Date.parse(points.at(-1)?.sampledAt ?? '') - 365 * DAY_MS;
  const byDay = new Map<string, number>();
  for (const point of points) {
    const time = Date.parse(point.sampledAt ?? '');
    if (!Number.isFinite(time) || time < cutoff) continue;
    const day = point.sampledAt!.slice(0, 10);
    byDay.set(day, Math.max(byDay.get(day) ?? Number.NEGATIVE_INFINITY, finiteNumber(point.sigmaShift, 0)));
  }
  const dailyMax = Array.from(byDay.values()).sort((a, b) => b - a);
  if (!dailyMax.length) return DEFAULT_ALARM_SIGMA;
  if (dailyMax.length === 1) return Math.max(DEFAULT_ALARM_SIGMA, Math.ceil(dailyMax[0] * 10) / 10);
  return Math.max(DEFAULT_ALARM_SIGMA, Math.ceil((dailyMax[1] + 0.05) * 10) / 10);
}

function dedupeHolidayWindows(windows: HolidayWindow[]): HolidayWindow[] {
  const seen = new Map<string, HolidayWindow>();
  for (const window of windows) {
    const key = [window.id, window.startsAt, window.endsAt].filter(Boolean).join('|');
    if (key && !seen.has(key)) seen.set(key, window);
  }
  return Array.from(seen.values()).sort((a, b) => Date.parse(a.startsAt ?? '') - Date.parse(b.startsAt ?? ''));
}

function countModels(aircraft: Aircraft[]): ModelCount[] {
  const counts = new Map<string, number>();
  for (const plane of aircraft) {
    const label = normalizeModelLabel(plane.label ?? plane.registration ?? plane.hex ?? 'Unknown');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count, capacity: capacityForModel(label), wiki: wikiForModel(label) }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function estimateSeats(aircraft: Aircraft[]): SeatEstimate {
  const capacities = aircraft.map((plane) => capacityForModel(plane.label ?? '')).filter((capacity): capacity is number => capacity != null);
  const knownSeats = capacities.reduce((sum, value) => sum + value, 0);
  const knownAircraftCount = capacities.length;
  const totalAircraftCount = aircraft.length;
  const estimatedSeats = knownAircraftCount ? Math.round(knownSeats + (totalAircraftCount - knownAircraftCount) * (knownSeats / knownAircraftCount)) : null;
  return { knownAircraftCount, totalAircraftCount, knownSeats, estimatedSeats };
}

const CAPACITY_PATTERNS: Array<[RegExp, number, string?]> = [
  [/A320|BOEING 737|B737|767|BAE 146/i, 180],
  [/GLOBAL|BD-700|G650|GVI|GVII|G550|GV-SP|G600/i, 19, 'https://en.wikipedia.org/wiki/Gulfstream_G650'],
  [/FALCON 7X|FALCON 8X/i, 16, 'https://en.wikipedia.org/wiki/Dassault_Falcon_7X'],
  [/FALCON 2000|FALCON 900/i, 10, 'https://en.wikipedia.org/wiki/Dassault_Falcon_2000'],
  [/CHALLENGER|BD-100|CL-600|CANADAIR/i, 10, 'https://en.wikipedia.org/wiki/Bombardier_Challenger_300'],
  [/CITATION LATITUDE|680A|CITATION SOVEREIGN|\b680\b/i, 9, 'https://en.wikipedia.org/wiki/Cessna_Citation_Latitude'],
  [/560XL|CITATION XLS|CITATION EXCEL/i, 10, 'https://en.wikipedia.org/wiki/Cessna_Citation_Excel'],
  [/CESSNA 525|CITATIONJET|CJ2|CJ3|CJ4|M2/i, 7, 'https://en.wikipedia.org/wiki/Cessna_CitationJet/M2'],
  [/PHENOM 300|EMB-505/i, 10, 'https://en.wikipedia.org/wiki/Embraer_Phenom_300'],
  [/PRAETOR|EMB-550|EMB-545|LEGACY/i, 12, 'https://en.wikipedia.org/wiki/Embraer_Praetor_500/600'],
  [/PC-24/i, 10, 'https://en.wikipedia.org/wiki/Pilatus_PC-24'],
  [/HONDA|HA-420/i, 6, 'https://en.wikipedia.org/wiki/Honda_HA-420_HondaJet'],
  [/HAWKER|BEECHJET|400A|400XT/i, 8, 'https://en.wikipedia.org/wiki/Beechcraft_400'],
  [/LEARJET 75|LEARJET 60|LEARJET 45|LEARJET/i, 8, 'https://en.wikipedia.org/wiki/Learjet_45'],
  [/CIRRUS|SF50|VISION/i, 5, 'https://en.wikipedia.org/wiki/Cirrus_Vision_SF50'],
];

function capacityForModel(label: string): number | null {
  return CAPACITY_PATTERNS.find(([pattern]) => pattern.test(label))?.[1] ?? null;
}

function wikiForModel(label: string): string | undefined {
  return CAPACITY_PATTERNS.find(([pattern]) => pattern.test(label))?.[2];
}

function normalizeModelLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim() || 'Unknown';
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampLevel(value: unknown): number {
  return Math.min(LEVEL_COUNT, Math.max(1, Math.round(finiteNumber(value, 1))));
}

function isFiniteCoordinate(lat: unknown, lon: unknown): lat is number {
  const parsedLat = Number(lat);
  const parsedLon = Number(lon);
  return Number.isFinite(parsedLat) && Number.isFinite(parsedLon) && parsedLat >= -90 && parsedLat <= 90 && parsedLon >= -180 && parsedLon <= 180;
}

function project(lon: number, lat: number, width: number, height: number) {
  return { x: ((lon + 180) / 360) * width, y: ((90 - lat) / 180) * height };
}

function makeDateTicks(data: ArchivePoint[], count: number) {
  if (!data.length) return [];
  return Array.from({ length: count }, (_, tickIndex) => {
    const index = Math.round((tickIndex / Math.max(1, count - 1)) * (data.length - 1));
    return { index, label: formatShortDate(data[index]?.sampledAt) };
  });
}

function formatInteger(value: number) {
  return Math.round(value).toLocaleString();
}

function formatNumber(value: number, digits = 0) {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function formatSigned(value: number, digits = 0) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded >= 0 ? '+' : ''}${rounded.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })}`;
}

function formatNullableNumber(value: unknown, digits = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? formatNumber(parsed, digits) : '—';
}

function formatAxis(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return 'not reported';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(date);
}

function formatShortDate(value: string | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date);
}

export default App;
