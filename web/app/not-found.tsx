import Link from "next/link";

export default function NotFound() {
  return (
    <main className="shell">
      <section className="hero reveal">
        <div className="hero-kicker">Dashboard</div>
        <h1 className="hero-title">Whale not found</h1>
        <p className="hero-copy">
          Die angeforderte Whale-Ansicht konnte nicht aufgebaut werden. Entweder existiert die Adresse aktuell nicht
          mehr im Snapshot oder es gibt noch keine Daten dazu.
        </p>
        <div className="hero-actions">
          <Link href="/" className="button-secondary">Zurueck zum Dashboard</Link>
        </div>
      </section>
    </main>
  );
}