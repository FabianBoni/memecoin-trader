"use client";

import { startTransition, useEffect } from "react";
import { useRouter } from "next/navigation";

export function AutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      startTransition(() => {
        router.refresh();
      });
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs, router]);

  return null;
}