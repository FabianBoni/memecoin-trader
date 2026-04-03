import Link from "next/link";
import {
  getDashboardSnapshot,
  type DashboardDiagnostic,
} from "../../src/dashboard/data";
import { resetAllPaperWhalesAction, resetAllWhalesAction, resetPaperWhaleAction } from "./actions";
import { AutoRefresh } from "../components/auto-refresh";
import { EmptyState, MetricTile, Panel, StatusPill } from "../components/primitives";
import {
  formatCompactNumber,
  formatCount,
  formatDateTime,
  formatEntrySourceLabel,
  formatFractionPct,
  formatPct,
  formatSolPrice,
  formatUsd,
  shortenAddress,
} from "../lib/format";

export const dynamic = "force-dynamic";

type SearchParams = {
  message?: string | string[];
};

const FLASH_MESSAGES: Record<string, { tone: "good" | "warn" | "bad"; text: string }> = {
  "paper-whale-reset": { tone: "good", text: "Paper-Daten fuer den Wal wurden zurueckgesetzt." },
  "paper-all-reset": { tone: "good", text: "Alle Paper-Bewertungen und offenen Paper-Trades wurden geloescht." },
  "whales-all-reset": { tone: "warn", text: "Alle Wale, Whale-Stats und Paper-Daten wurden geloescht." },
  "missing-whale": { tone: "bad", text: "Fuer den Reset wurde keine Wal-Adresse uebergeben." },
};

function normalizeSearchParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function diagnosticToneToPill(tone: DashboardDiagnostic["tone"]): "good" | "warn" | "bad" | "neutral" {
  return tone;
}

function stateTone(value: unknown): "good" | "warn" | "bad" | "neutral" {
  switch (String(value ?? "")) {
    case "idle":
    case "monitoring":
    case "tracking":
      return "good";
    case "starting":
      return "warn";
    case "error":
      return "bad";
    default:
      return "neutral";
  }
}

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

function decisionLabel(outcome: string): string {
  switch (outcome) {
    case "cluster-floor-blocked":
      return "Cluster floor blocked";
    case "paper-bypass":
      return "Paper bypass";
    case "paper-signal-blocked":
      return "Paper blocked";
    case "entry-rejected":
      return "Entry rejected";
    case "paper-opened":
      return "Paper opened";
    case "paper-entry-missing":
      return "Missing entry";
    case "live-skipped-active-position":
      return "Live skipped";
    case "live-blocked":
      return "Live blocked";
    case "live-sizing-blocked":
      return "Sizing blocked";
    case "live-opened":
      return "Live opened";
    case "live-buy-failed":
      return "Live failed";
    default:
      return outcome;
  }
}

export default async function DashboardPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  const resolvedSearchParams = (await searchParams) ?? {};
  const snapshot = getDashboardSnapshot();
  const scoutStatus = (snapshot.runtimeStatus.scout ?? {}) as Record<string, unknown>;
  const trackerStatus = (snapshot.runtimeStatus.tracker ?? {}) as Record<string, unknown>;
  const monitorStatus = (snapshot.runtimeStatus.positionManager ?? {}) as Record<string, unknown>;
  const messageCode = normalizeSearchParam(resolvedSearchParams.message);
  const flash = messageCode ? FLASH_MESSAGES[messageCode] ?? null : null;
  const latestPaperSignalDiagnostic = snapshot.diagnostics.find((entry) => entry.key === "tracker-paper-bypass" || entry.key === "tracker-paper-block");

  return (
    <main className="shell">
      <AutoRefresh intervalMs={10_000} />

      <section className="hero reveal">
        <div className="hero-kicker">Memecoin Trader</div>
        <h1 className="hero-title">Operator Console</h1>
        <p className="hero-copy">
          Die neue Oberfläche trennt Signalfluss, Blocker und offene Positionen klar voneinander. Du siehst nicht
          nur Endzustände, sondern die letzten Stellen, an denen Scout, Tracker oder Paper-Flow hängen geblieben sind.
        </p>
        <div className="hero-meta">
          <span className="hero-chip">Snapshot {formatDateTime(snapshot.generatedAt)}</span>
          <span className="hero-chip">Auto refresh 10s</span>
          <span className="hero-chip">Paper promotion {snapshot.thresholds.paperPromotionMinTrades} trades</span>
          <span className="hero-chip">Cluster floor {formatUsd(snapshot.thresholds.trackerSignalMinBuyUsd)}</span>
        </div>
        <div className="hero-actions">
          <form action={resetAllPaperWhalesAction}>
            <button type="submit" className="button-secondary">Reset paper evaluations</button>
          </form>
          <form action={resetAllWhalesAction}>
            <button type="submit" className="button-danger">Delete all whales</button>
          </form>
        </div>
      </section>

      {flash ? (
        <div className="flash-bar">
          <div className={`flash flash-${flash.tone}`}>{flash.text}</div>
        </div>
      ) : null}

      <div className="metric-grid">
        <MetricTile
          label="Whales"
          value={formatCount(snapshot.totals.whales)}
          detail={`Live ${formatCount(snapshot.totals.liveWhales)} · Paper ${formatCount(snapshot.totals.paperWhales)}`}
          tone="cyan"
        />
        <MetricTile
          label="Open live positions"
          value={formatCount(snapshot.totals.openLiveTrades)}
          detail={`Runner ${formatCount(snapshot.totals.runnerCount)} · Partial ${formatCount(snapshot.totals.partialOpenCount)}`}
          tone="amber"
        />
        <MetricTile
          label="Open paper trades"
          value={formatCount(snapshot.totals.openPaperTrades)}
          detail={`Evaluated ${formatCount(snapshot.totals.totalPaperEvaluatedTrades)} · Discards ${formatCount(snapshot.totals.totalPaperDiscards)}`}
          tone="coral"
        />
        <MetricTile
          label="Live evaluations"
          value={formatCount(snapshot.totals.totalLiveEvaluatedTrades)}
          detail={`Final exits ${formatCount(snapshot.totals.finalizedExitCount)} · Partial exits ${formatCount(snapshot.totals.partialExitCount)}`}
          tone="slate"
        />
        <MetricTile
          label="Avg realized PnL"
          value={formatPct(snapshot.totals.averageRealizedPnlPct)}
          detail={`Global win rate ${formatPct(snapshot.totals.globalWinRatePct)}`}
          tone={snapshot.totals.averageRealizedPnlPct !== null && snapshot.totals.averageRealizedPnlPct < 0 ? "coral" : "cyan"}
        />
      </div>

      <div className="runtime-grid">
        <Panel eyebrow="Runtime" title="Scout" tone="cyan">
          <div className="runtime-facts">
            <div className="fact-row">
              <div className="fact-label">State</div>
              <div className="fact-value"><StatusPill tone={stateTone(scoutStatus.state)}>{String(scoutStatus.state ?? "n/a")}</StatusPill></div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Last cycle</div>
              <div className="fact-value">{formatDateTime(String(scoutStatus.lastRunAt ?? scoutStatus.lastSuccessAt ?? ""))}</div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Seed quality</div>
              <div className="fact-value">{formatCount(Number(scoutStatus.highVolumeSeedCount ?? 0))} / {formatCount(Number(scoutStatus.eligibleSeedCount ?? 0))}</div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Last token</div>
              <div className="fact-value mono">{shortenAddress(String(scoutStatus.lastToken ?? "n/a"), 10, 4)}</div>
            </div>
          </div>
        </Panel>

        <Panel eyebrow="Runtime" title="Tracker" tone="amber">
          <div className="runtime-facts">
            <div className="fact-row">
              <div className="fact-label">State</div>
              <div className="fact-value"><StatusPill tone={stateTone(trackerStatus.state)}>{String(trackerStatus.state ?? "n/a")}</StatusPill></div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Subscriptions</div>
              <div className="fact-value">{formatCount(Number(trackerStatus.activeSubscriptions ?? 0))}</div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Last signal</div>
              <div className="fact-value">{formatDateTime(String(trackerStatus.lastSignalAt ?? ""))}</div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Last signal mint</div>
              <div className="fact-value mono">{shortenAddress(String(trackerStatus.lastSignalMint ?? "n/a"), 10, 4)}</div>
            </div>
          </div>
        </Panel>

        <Panel eyebrow="Runtime" title="Position monitor" tone="coral">
          <div className="runtime-facts">
            <div className="fact-row">
              <div className="fact-label">State</div>
              <div className="fact-value"><StatusPill tone={stateTone(monitorStatus.state)}>{String(monitorStatus.state ?? "n/a")}</StatusPill></div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Open positions</div>
              <div className="fact-value">Paper {formatCount(Number(monitorStatus.openPaperTrades ?? 0))} · Live {formatCount(Number(monitorStatus.openLiveTrades ?? 0))}</div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Price cache</div>
              <div className="fact-value">{formatCount(Number(monitorStatus.priceCacheEntries ?? 0))}</div>
            </div>
            <div className="fact-row">
              <div className="fact-label">Last cycle</div>
              <div className="fact-value">{formatDateTime(String(monitorStatus.lastRunAt ?? monitorStatus.lastErrorAt ?? ""))}</div>
            </div>
          </div>
        </Panel>
      </div>

      <Panel eyebrow="Why it worked or failed" title="Latest pipeline evidence" tone="slate">
        <div className="diagnostic-grid">
          {snapshot.diagnostics.map((diagnostic) => (
            <article key={diagnostic.key} className={`diagnostic-card ${diagnostic.tone}`}>
              <StatusPill tone={diagnosticToneToPill(diagnostic.tone)}>{diagnostic.title}</StatusPill>
              <h3 className="diagnostic-title">{formatDateTime(diagnostic.detectedAt)}</h3>
              <p className="diagnostic-detail">{diagnostic.detail}</p>
            </article>
          ))}
        </div>
      </Panel>

      <Panel eyebrow={`${formatCount(snapshot.decisionEvents.length)} newest decisions`} title="Decision stream" tone="coral">
        {snapshot.decisionEvents.length === 0 ? (
          <EmptyState title="No decision events yet" detail="Sobald der Tracker Signale bewertet, erscheinen hier die letzten Oeffnungen, Rejects und Blocks." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Outcome</th>
                  <th>Whale</th>
                  <th>Token</th>
                  <th>Detail</th>
                  <th className="align-right">Metrics</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.decisionEvents.map((event) => (
                  <tr key={event.id}>
                    <td>{formatDateTime(event.detectedAt)}</td>
                    <td><StatusPill tone={decisionTone(event.outcome)}>{decisionLabel(event.outcome)}</StatusPill></td>
                    <td className="mono"><Link className="address-link" href={`/whales/${encodeURIComponent(event.whale)}`}>{shortenAddress(event.whale)}</Link></td>
                    <td className="mono"><a className="address-link" href={`https://solscan.io/token/${event.mint}`} target="_blank" rel="noreferrer">{shortenAddress(event.mint)}</a></td>
                    <td>
                      <div>{event.detail}</div>
                      <div className="table-note">
                        {event.performanceTier ?? "n/a"} · {event.signalStrategy ?? "n/a"}
                        {event.reasons.length > 0 ? ` · ${event.reasons[0]}` : ""}
                      </div>
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

      <div className="split-grid">
        <Panel eyebrow={`${formatCount(snapshot.liveTrades.length)} active`} title="Live positions" tone="cyan">
          {snapshot.liveTrades.length === 0 ? (
            <EmptyState title="No open live positions" detail="Der Tracker hat aktuell keine aktive Live-Position im Snapshot." />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Whale</th>
                    <th>Entry</th>
                    <th>Size</th>
                    <th>Realized</th>
                    <th>Last action</th>
                    <th className="align-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.liveTrades.map((trade) => (
                    <tr key={trade.mint}>
                      <td className="mono"><a className="address-link" href={`https://solscan.io/token/${trade.mint}`} target="_blank" rel="noreferrer">{shortenAddress(trade.mint)}</a></td>
                      <td className="mono"><Link className="address-link" href={`/whales/${encodeURIComponent(trade.whale)}`}>{shortenAddress(trade.whale, 8, 4)}</Link></td>
                      <td>
                        <div>{formatUsd(trade.entryPrice)}</div>
                        <div className="table-note">{formatEntrySourceLabel(trade.entryPriceSource)}</div>
                      </td>
                      <td>
                        <div>{trade.positionSol !== null ? `${trade.positionSol.toFixed(2)} SOL` : "n/a"}</div>
                        <div className="table-note">Open {formatFractionPct(trade.remainingFraction)} · Sold {formatFractionPct(trade.realizedSoldFraction)}</div>
                      </td>
                      <td>
                        <div>{formatPct(trade.realizedPnlPct)}</div>
                        <div className="table-note">Trim pending {formatFractionPct(trade.pendingTrimFraction)}</div>
                      </td>
                      <td>
                        <div>{trade.lastActionReason ?? "Entry"}</div>
                        <div className="table-note">{formatDateTime(trade.lastActionAt)}</div>
                      </td>
                      <td className="align-right">
                        {trade.panic ? <StatusPill tone="bad">panic</StatusPill> : null}
                        {!trade.panic && trade.takeProfitTaken ? <StatusPill tone="good">runner</StatusPill> : null}
                        {!trade.panic && !trade.takeProfitTaken && trade.realizedSoldFraction > 0 ? <StatusPill tone="warn">partial</StatusPill> : null}
                        {!trade.panic && !trade.takeProfitTaken && trade.realizedSoldFraction === 0 ? <StatusPill tone="neutral">tracked</StatusPill> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel eyebrow={`${formatCount(snapshot.paperTrades.length)} open`} title="Paper trades" tone="amber">
          {snapshot.paperTrades.length === 0 ? (
            <EmptyState
              title="No open paper trades"
              detail={latestPaperSignalDiagnostic ? `${latestPaperSignalDiagnostic.title}: ${latestPaperSignalDiagnostic.detail}` : "Es gibt aktuell keinen offenen Bewertungs-Trade im Paper-Book."}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Whale</th>
                    <th>Entry</th>
                    <th>Opened</th>
                    <th>Realized</th>
                    <th>Sample</th>
                    <th className="align-right">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.paperTrades.map((trade) => (
                    <tr key={trade.tradeId}>
                      <td className="mono"><a className="address-link" href={`https://solscan.io/token/${trade.mint}`} target="_blank" rel="noreferrer">{shortenAddress(trade.mint)}</a></td>
                      <td className="mono"><Link className="address-link" href={`/whales/${encodeURIComponent(trade.whale)}`}>{shortenAddress(trade.whale, 8, 4)}</Link></td>
                      <td>
                        <div>{trade.entryPriceSource === "wallet-receipt-sol-only" ? formatSolPrice(trade.entryPriceSol) : formatUsd(trade.entryPrice)}</div>
                        <div className="table-note">{formatEntrySourceLabel(trade.entryPriceSource)}</div>
                      </td>
                      <td>
                        <div>{formatDateTime(trade.openedAt)}</div>
                        <div className="table-note">Open {formatFractionPct(trade.remainingFraction)}</div>
                      </td>
                      <td>
                        <div>{formatPct(trade.realizedPnlPct)}</div>
                        <div className="table-note">{trade.lastActionReason ?? "no partial yet"} · {formatDateTime(trade.lastActionAt)}</div>
                      </td>
                      <td>
                        <div>{formatCount(trade.evaluatedTrades)} / {formatCount(snapshot.thresholds.paperPromotionMinTrades)}</div>
                        <div className="table-note">Discards {formatCount(trade.noPriceDiscards)}</div>
                      </td>
                      <td className="align-right">
                        {trade.panic ? <StatusPill tone="bad">panic</StatusPill> : null}
                        {!trade.panic && trade.takeProfitTaken ? <StatusPill tone="good">runner</StatusPill> : null}
                        {!trade.panic && !trade.takeProfitTaken && trade.whaleSoldFraction > 0 ? <StatusPill tone="warn">trim</StatusPill> : null}
                        {!trade.panic && !trade.takeProfitTaken && trade.whaleSoldFraction === 0 ? <StatusPill tone="neutral">paper</StatusPill> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="split-grid">
        <Panel eyebrow={`${formatCount(snapshot.leaderboard.length)} ranked`} title="Live leaderboard" tone="slate">
          {snapshot.leaderboard.length === 0 ? (
            <EmptyState title="No ranked whales yet" detail="Es wurden noch keine Live-Trades fuer die Leaderboard-Auswertung abgeschlossen." />
          ) : (
            <div className="list-scroll">
              {snapshot.leaderboard.map((entry) => (
                <div key={entry.address} className="list-row">
                  <div className="stack">
                    <Link className="list-title mono address-link" href={`/whales/${encodeURIComponent(entry.address)}`}>{shortenAddress(entry.address)}</Link>
                    <div className="list-meta">Trades {formatCount(entry.total)} · Streak {entry.streak || "n/a"} · Median {formatPct(entry.medianPnlPct)}</div>
                  </div>
                  <div className="stack" style={{ alignItems: "flex-end" }}>
                    <StatusPill tone={entry.avgPnlPct !== null && entry.avgPnlPct < 0 ? "bad" : "good"}>{formatPct(entry.avgPnlPct)}</StatusPill>
                    <div className="list-meta">W {formatCount(entry.wins)} / L {formatCount(entry.losses)} · Win {formatPct(entry.winRatePct)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel eyebrow={`${formatCount(snapshot.paperWhales.length)} quarantined`} title="Quarantine whales" tone="coral">
          {snapshot.paperWhales.length === 0 ? (
            <EmptyState title="No quarantine whales" detail="Aktuell gibt es keine Wale im Paper-Pruefmodus." />
          ) : (
            <div className="list-scroll">
              {snapshot.paperWhales.map((whale) => (
                <div key={whale.address} className="list-row">
                  <div className="stack">
                    <Link className="list-title mono address-link" href={`/whales/${encodeURIComponent(whale.address)}`}>{shortenAddress(whale.address)}</Link>
                    <div className="list-meta">Discovery {formatDateTime(whale.discoveredAt ?? null)} · Discards {formatCount(whale.noPriceDiscards)} · Seed {shortenAddress(String(whale.lastScoutedToken ?? "n/a"), 10, 4)}</div>
                    <div className="list-meta">Win {formatPct(whale.winRatePct)} · Avg {formatPct(whale.avgPnlPct)} · Median {formatPct(whale.medianPnlPct)}</div>
                  </div>
                  <div className="stack" style={{ alignItems: "flex-end" }}>
                    {whale.readyForPromotion ? <StatusPill tone="good">promotion ready</StatusPill> : <StatusPill tone="neutral">{formatCount(whale.total)} / {formatCount(snapshot.thresholds.paperPromotionMinTrades)}</StatusPill>}
                    <form action={resetPaperWhaleAction} className="row-tools">
                      <input type="hidden" name="whaleAddress" value={whale.address} />
                      <button type="submit" className="button-inline">Reset</button>
                    </form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel eyebrow={`${formatCount(snapshot.whaleActivity.length)} newest events`} title="Recent whale activity" tone="cyan">
        {snapshot.whaleActivity.length === 0 ? (
          <EmptyState title="No whale activity yet" detail="Bisher wurde noch kein Whale-Event im Aktivitaetslog registriert." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Detected</th>
                  <th>Whale</th>
                  <th>Token</th>
                  <th>Side</th>
                  <th>Mode</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.whaleActivity.map((entry, index) => (
                  <tr key={`${entry.whale}:${entry.mint}:${entry.detectedAt ?? index}`}>
                    <td>{formatDateTime(entry.detectedAt)}</td>
                    <td className="mono"><Link className="address-link" href={`/whales/${encodeURIComponent(entry.whale)}`}>{shortenAddress(entry.whale)}</Link></td>
                    <td className="mono"><a className="address-link" href={`https://solscan.io/token/${entry.mint}`} target="_blank" rel="noreferrer">{shortenAddress(entry.mint)}</a></td>
                    <td>{entry.side}</td>
                    <td>{entry.botMode ?? "n/a"}</td>
                    <td className="mono">{entry.signature ? <a className="address-link" href={`https://solscan.io/tx/${entry.signature}`} target="_blank" rel="noreferrer">{shortenAddress(entry.signature, 8, 4)}</a> : "n/a"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel eyebrow={`${formatCount(snapshot.recentExits.length)} stored rows`} title="Recent exits" tone="amber">
        {snapshot.recentExits.length === 0 ? (
          <EmptyState title="No exits recorded" detail="Die Historie enthaelt aktuell keine abgeschlossenen oder partiellen Exits." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Token</th>
                  <th>Type</th>
                  <th>Size</th>
                  <th>USD fill</th>
                  <th>SOL fill</th>
                  <th>Source</th>
                  <th className="align-right">PnL</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.recentExits.map((entry, index) => (
                  <tr key={`${entry.mint}:${entry.date ?? index}:${entry.reason ?? "row"}`}>
                    <td>{formatDateTime(entry.date)}</td>
                    <td className="mono"><a className="address-link" href={`https://solscan.io/token/${entry.mint}`} target="_blank" rel="noreferrer">{shortenAddress(entry.mint, 8, 4)}</a></td>
                    <td>
                      <div>{entry.partial ? "partial" : "final"}</div>
                      <div className="table-note">{entry.reason ?? "unknown"}</div>
                    </td>
                    <td>
                      <div>{entry.soldFractionPct !== null ? `${entry.soldFractionPct.toFixed(1)}%` : "n/a"}</div>
                      <div className="table-note">Rest {entry.remainingFractionPct !== null ? `${entry.remainingFractionPct.toFixed(1)}%` : "n/a"}</div>
                    </td>
                    <td>{formatUsd(entry.entryPriceUsd)} → {formatUsd(entry.exitPriceUsd)}</td>
                    <td>{formatSolPrice(entry.entryPriceSol)} → {formatSolPrice(entry.exitPriceSol)}</td>
                    <td>{entry.priceSource ?? "n/a"}</td>
                    <td className="align-right"><StatusPill tone={entry.pnlPct !== null && entry.pnlPct < 0 ? "bad" : "good"}>{formatPct(entry.combinedPnlPct ?? entry.pnlPct)}</StatusPill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </main>
  );
}