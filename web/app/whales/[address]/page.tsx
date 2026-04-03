import Link from "next/link";
import { notFound } from "next/navigation";
import { getWhaleDetailSnapshot } from "../../../../src/dashboard/data";
import { resetPaperWhaleAction } from "../../actions";
import { AutoRefresh } from "../../../components/auto-refresh";
import { EmptyState, MetricTile, Panel, StatusPill } from "../../../components/primitives";
import {
  formatDateTime,
  formatPct,
  formatSignedNumber,
  formatUsd,
  shortenAddress,
} from "../../../lib/format";

export const dynamic = "force-dynamic";

function decisionTone(outcome: string): "good" | "warn" | "bad" | "neutral" {
  switch (outcome) {
    case "paper-opened":
    case "live-opened":
      return "good";
    case "paper-bypass":
    case "live-blocked":
    case "live-skipped-active-position":
    case "live-sizing-blocked":
      return "warn";
    case "cluster-floor-blocked":
    case "paper-signal-blocked":
    case "entry-rejected":
    case "paper-entry-missing":
    case "live-buy-failed":
      return "bad";
    default:
      return "neutral";
  }
}

export default async function WhaleDetailPage({ params }: { params: Promise<{ address: string }> }) {
  const resolvedParams = await params;
  const address = decodeURIComponent(resolvedParams.address);
  const snapshot = await getWhaleDetailSnapshot(address);

  if (!snapshot) {
    notFound();
  }

  const whale = snapshot.whale;

  return (
    <main className="shell">
      <AutoRefresh intervalMs={12_000} />

      <section className="hero reveal">
        <div className="hero-kicker">Whale detail</div>
        <h1 className="hero-title mono">{address}</h1>
        <p className="hero-copy">
          Diese Ansicht kombiniert lokale Whale-Aktivitaet mit den letzten 12 Stunden on-chain-Transaktionen. So
          erkennst du direkt, ob das Problem in der Beobachtung, im Cluster-Gate oder erst in der Entry-Entscheidung steckt.
        </p>
        <div className="hero-meta">
          <span className="hero-chip">Mode {whale?.mode ?? "untracked"}</span>
          <span className="hero-chip">Discovered {formatDateTime(whale?.discoveredAt ?? null)}</span>
          <span className="hero-chip">Seed rank {whale?.seedTraderRank ?? "n/a"}</span>
        </div>
        <div className="hero-actions">
          <Link href="/" className="button-secondary">Zurueck zum Dashboard</Link>
          {whale?.mode === "paper" ? (
            <form action={resetPaperWhaleAction}>
              <input type="hidden" name="whaleAddress" value={address} />
              <button type="submit" className="button-inline">Reset paper data</button>
            </form>
          ) : null}
        </div>
      </section>

      <div className="metric-grid">
        <MetricTile label="12h transactions" value={String(snapshot.transactions.length)} detail="Parsed directly from RPC" tone="cyan" />
        <MetricTile label="Live evaluated" value={String(snapshot.liveSummary.evaluatedTrades)} detail={`Win ${formatPct(snapshot.liveSummary.winRatePct)} · Avg ${formatPct(snapshot.liveSummary.avgPnlPct)}`} tone="amber" />
        <MetricTile label="Paper evaluated" value={String(snapshot.paperSummary.evaluatedTrades)} detail={`Win ${formatPct(snapshot.paperSummary.winRatePct)} · Avg ${formatPct(snapshot.paperSummary.avgPnlPct)}`} tone="coral" />
        <MetricTile label="Paper discards" value={String(snapshot.paperSummary.noPriceDiscards)} detail={`Streak ${snapshot.paperSummary.streak || "n/a"}`} tone="slate" />
        <MetricTile label="Median PnL" value={formatPct(snapshot.paperSummary.medianPnlPct)} detail={`Live ${formatPct(snapshot.liveSummary.medianPnlPct)}`} tone="cyan" />
        <MetricTile label="Panic exit rate" value={formatPct(snapshot.liveSummary.panicExitRatePct)} detail={`Avg hold ${snapshot.liveSummary.avgHoldMinutes?.toFixed(1) ?? "n/a"} min`} tone="amber" />
      </div>

      <Panel eyebrow={`${snapshot.decisionEvents.length} recent decisions`} title="Decision trail" tone="amber">
        {snapshot.decisionEvents.length === 0 ? (
          <EmptyState title="No decisions stored for this whale" detail="Sobald dieser Wal bewertet oder geblockt wird, erscheint hier der lokale Entscheidungsverlauf." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Outcome</th>
                  <th>Token</th>
                  <th>Detail</th>
                  <th className="align-right">Metrics</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.decisionEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.detectedAt)}</td>
                    <td><StatusPill tone={decisionTone(event.outcome)}>{event.outcome}</StatusPill></td>
                    <td className="mono"><a className="address-link" href={`https://solscan.io/token/${event.mint}`} target="_blank" rel="noreferrer">{shortenAddress(event.mint, 8, 4)}</a></td>
                    <td>
                      <div>{event.detail}</div>
                      <div className="table-note">{event.performanceTier ?? "n/a"} · {event.signalStrategy ?? "n/a"}{event.reasons.length > 0 ? ` · ${event.reasons[0]}` : ""}</div>
                    </td>
                    <td className="align-right">
                      <div>Buy {formatUsd(event.whaleBuySizeUsd)}</div>
                      <div className="table-note">Liq {formatUsd(event.liquidityUsd)} · RR {event.rewardRiskRatio !== null ? event.rewardRiskRatio.toFixed(2) : "n/a"}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="detail-grid">
        <Panel eyebrow={`${snapshot.transactions.length} tx rows`} title="Recent on-chain transactions" tone="cyan">
          {snapshot.transactions.length === 0 ? (
            <EmptyState title="No recent transactions" detail="In den letzten 12 Stunden wurden fuer diese Adresse keine relevanten Transaktionen geladen." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Status</th>
                    <th>SOL delta</th>
                    <th>Fee</th>
                    <th>Token changes</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.transactions.map((tx) => (
                    <tr key={tx.signature}>
                      <td>{formatDateTime(tx.detectedAt)}</td>
                      <td>{tx.success ? <StatusPill tone="good">ok</StatusPill> : <StatusPill tone="bad">failed</StatusPill>}</td>
                      <td>{tx.solDelta === null ? "n/a" : `${formatSignedNumber(tx.solDelta)} SOL`}</td>
                      <td>{tx.feeSol.toFixed(6)} SOL</td>
                      <td>
                        {tx.tokenDeltas.length === 0 ? (
                          <span className="table-note">no token delta</span>
                        ) : (
                          <div className="token-deltas">
                            {tx.tokenDeltas.slice(0, 4).map((delta) => (
                              <span key={`${tx.signature}:${delta.mint}`} className={`token-delta ${delta.delta > 0 ? "token-delta-positive" : "token-delta-negative"}`}>
                                {formatSignedNumber(delta.delta, 2)} {shortenAddress(delta.mint, 6, 4)}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="mono"><a className="address-link" href={`https://solscan.io/tx/${tx.signature}`} target="_blank" rel="noreferrer">{shortenAddress(tx.signature, 8, 4)}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel eyebrow={`${snapshot.activity.length} local events`} title="Bot-detected whale activity" tone="coral">
          {snapshot.activity.length === 0 ? (
            <EmptyState title="No local whale events" detail="Der Tracker hat fuer diesen Wal noch keine lokalen Buy- oder Sell-Events im Snapshot gespeichert." />
          ) : (
            <div className="list-scroll">
              {snapshot.activity.map((entry, index) => (
                <div key={`${entry.whale}:${entry.mint}:${entry.detectedAt ?? index}`} className="list-row">
                  <div className="stack">
                    <a className="list-title mono address-link" href={`https://solscan.io/token/${entry.mint}`} target="_blank" rel="noreferrer">{shortenAddress(entry.mint, 8, 4)}</a>
                    <div className="list-meta">{formatDateTime(entry.detectedAt)} · mode {entry.botMode ?? "n/a"}</div>
                  </div>
                  <div className="stack" style={{ alignItems: "flex-end" }}>
                    <StatusPill tone={entry.side === "buy" ? "good" : "bad"}>{entry.side}</StatusPill>
                    <div className="list-meta">{entry.signature ? <a className="address-link mono" href={`https://solscan.io/tx/${entry.signature}`} target="_blank" rel="noreferrer">{shortenAddress(entry.signature, 8, 4)}</a> : "n/a"}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </main>
  );
}