import { useEffect, useState } from "react";

/** Relative timestamps stay compact at all ages. */
export function formatRelative(timestamp: number): string {
  const age = Math.max(0, Date.now() - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (age < minute) return "now";
  if (age < hour) return `${Math.floor(age / minute)}m`;
  if (age < day) return `${Math.floor(age / hour)}h`;
  if (age < 7 * day) return `${Math.floor(age / day)}d`;
  if (age < 30 * day) return `${Math.floor(age / (7 * day))}w`;
  if (age < 365 * day) return `${Math.floor(age / (30 * day))}mo`;
  return `${Math.floor(age / (365 * day))}y`;
}

/** Refresh visible relative timestamps once a minute. */
export function useRelativeClock(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const refresh = () => setTick(value => value + 1);
    const timer = window.setInterval(refresh, 60_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, []);
}
