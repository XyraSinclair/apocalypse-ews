import { useEffect, useState } from 'react';
import './cbrn.css';

type Network = {
  source: string;
  stations: number;
  newestReading: string | null;
  readingAgeMinutes: number | null;
  consecutiveFailures: number;
  lastError: string | null;
};

type CbrnAlert = {
  kind: string;
  severity: string;
  occurredAt: string;
  title: string;
  message: string;
  createdAt: string;
};

type Summary = {
  generatedAt: string;
  instruments: {
    radiation: { networks: Network[]; reportingNetworks: number; status: string };
    aircraft: { regions: number; newestSample: string | null; sampleAgeMinutes: number | null };
    lexical: { regions: number; newestBucket: string | null };
  };
  alerts: CbrnAlert[];
  limits: string[];
};

const POLL_MS = 60_000;

// Some time, in plain words, for a reader who does not think in ISO strings.
function ago(value: string | null): string {
  if (!value) return 'never';
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function absolute(value: string | null): string {
  if (!value) return 'no time recorded';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function networkState(network: Network): { label: string; className: string } {
  if (network.consecutiveFailures >= 6) return { label: 'collection failing', className: 'unavailable' };
  if (network.readingAgeMinutes == null) return { label: 'no reading yet', className: 'unavailable' };
  if (network.readingAgeMinutes > 240) return { label: 'stale', className: 'stale' };
  return { label: 'reporting', className: 'reporting' };
}

export default function CbrnPage() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch('/api/cbrn', { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`CBRN status returned ${response.status}`);
        const payload = (await response.json()) as Summary;
        if (!cancelled) {
          setData(payload);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled && (caught as Error).name !== 'AbortError') {
          setError((caught as Error).message || 'CBRN status could not be read.');
        }
      }
    };
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const latest = data?.alerts?.[0] ?? null;
  const radiation = data?.instruments.radiation;

  return (
    <main className="cbrn-page">
        <h1>CBRN watch</h1>
        <p className="cbrn-lede">
          A continuous public-source watch for chemical, biological, radiological and nuclear risk:
          open gamma-dose-rate telemetry, sampled civil air traffic over CBRN-relevant places, public
          vocabulary bursts, and official notices. It measures and reports; it does not predict. It is not a
          missile-warning system and it cannot tell you that an area is safe.
        </p>

        {error && <p className="cbrn-error">Live CBRN status could not be read: {error}</p>}

        {latest ? (
          <section className={`cbrn-card severity-${latest.severity}`} aria-label="Most recent CBRN alert">
            <div className="cbrn-card-head">
              <span className={`cbrn-severity ${latest.severity}`}>{latest.severity}</span>
              <span className="cbrn-when">
                {absolute(latest.occurredAt)} · {ago(latest.occurredAt)}
              </span>
            </div>
            <h2 style={{ marginTop: 8 }}>{latest.title}</h2>
            <p className="cbrn-body">{latest.message}</p>
          </section>
        ) : (
          <section className="cbrn-card" aria-label="Current CBRN status">
            <h2 style={{ marginTop: 0 }}>No public CBRN alert is active</h2>
            <p className="cbrn-empty">
              Nothing this watch can see is above its alert threshold right now. That is a statement about
              four instruments, not about the world: see the coverage limits below.
            </p>
          </section>
        )}

        <h2>What to do if an alert concerns your area</h2>
        <ul className="cbrn-actions">
          <li><strong>Go inside and stay inside</strong> if a release is reported near you: close windows, doors and vents, and shut down fans or systems that pull outside air in.</li>
          <li><strong>Follow your official channels</strong> — local emergency management, national alert systems, the issuing authority named in the alert. Their instruction always outranks anything on this site.</li>
          <li><strong>Do not take potassium iodide unless officials tell you to.</strong> It only helps for specific radiological situations, at specific times, and can cause harm otherwise.</li>
          <li><strong>Do not evacuate into an area you cannot see.</strong> Leaving shelter is a decision for the authorities who know the plume.</li>
          <li>If you have a household plan, this is the moment it exists for: <a href="/plan">your alert plan</a>.</li>
        </ul>

        <h2>Instruments</h2>
        {radiation ? (
          <>
            <p className="cbrn-muted">
              Radiological telemetry: {radiation.reportingNetworks} of {radiation.networks.length} networks
              reporting within four hours. {radiation.status === 'reporting' ? '' : `Status: ${radiation.status}.`}
            </p>
            <table className="cbrn-table">
              <thead>
                <tr><th>Network</th><th>Stations</th><th>Last reading</th><th>Age</th><th>State</th></tr>
              </thead>
              <tbody>
                {radiation.networks.map((network) => {
                  const state = networkState(network);
                  return (
                    <tr key={network.source}>
                      <td>{network.source}</td>
                      <td>{network.stations.toLocaleString()}</td>
                      <td>{absolute(network.newestReading)}</td>
                      <td>{network.readingAgeMinutes == null ? '—' : `${network.readingAgeMinutes} min`}</td>
                      <td className={`cbrn-state ${state.className}`}>{state.label}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ) : (
          <p className="cbrn-empty">Radiological instrument status is not available.</p>
        )}

        <table className="cbrn-table">
          <tbody>
            <tr>
              <th>Air traffic sampling</th>
              <td>{data ? `${data.instruments.aircraft.regions} regions sampled` : 'loading'}</td>
              <td>{data ? ago(data.instruments.aircraft.newestSample) : '—'}</td>
            </tr>
            <tr>
              <th>Vocabulary bursts</th>
              <td>{data ? `${data.instruments.lexical.regions} places with counts` : 'loading'}</td>
              <td>{data ? ago(data.instruments.lexical.newestBucket) : '—'}</td>
            </tr>
          </tbody>
        </table>

        <h2>Recent public alerts</h2>
        {data && data.alerts.length > 0 ? (
          data.alerts.map((alert) => (
            <article className={`cbrn-card severity-${alert.severity}`} key={`${alert.kind}-${alert.createdAt}-${alert.title}`}>
              <div className="cbrn-card-head">
                <span className={`cbrn-severity ${alert.severity}`}>{alert.severity} · {alert.kind.replace(/^cbrn_/, '').replace(/_/g, ' ')}</span>
                <span className="cbrn-when">{absolute(alert.occurredAt)}</span>
              </div>
              <h3 style={{ marginTop: 8 }}>{alert.title}</h3>
              <p className="cbrn-body">{alert.message}</p>
            </article>
          ))
        ) : (
          <p className="cbrn-empty">No public CBRN alert has been issued.</p>
        )}

        <h2>What this watch cannot see</h2>
        <ul className="cbrn-actions">
          {(data?.limits ?? []).map((limit) => <li key={limit}>{limit}</li>)}
        </ul>
    </main>
  );
}
