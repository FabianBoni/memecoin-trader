import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Memecoin Trader Console",
  description: "Operational dashboard for scout, tracker, paper trades, and live execution diagnostics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}