"use client";

import { formatDistanceToNow, isValid, parseISO } from "date-fns";
import { cn } from "@/lib/utils";

/**
 * Render a relative time (e.g. "3 minutes ago").
 *
 * When `warnWithinHours` is set, the text turns amber when the target is within
 * that many hours in the future, and rose once it's in the past. Used for
 * expiry columns to make imminent expiries pop visually.
 */
export function RelativeTime({
  value,
  fallback = "—",
  suffix = true,
  warnWithinHours,
  className,
}: {
  value: string | null | undefined;
  fallback?: string;
  suffix?: boolean;
  /**
   * Optional: when set, the text is amber when the target is within this many
   * hours in the future, and rose when it's already past.
   */
  warnWithinHours?: number;
  className?: string;
}) {
  if (!value) return <span className={className}>{fallback}</span>;
  const date = parseISO(value);
  if (!isValid(date)) return <span className={className}>{fallback}</span>;

  let tone: "amber" | "rose" | null = null;
  if (typeof warnWithinHours === "number") {
    const now = Date.now();
    const ts = date.getTime();
    if (ts < now) {
      tone = "rose";
    } else if (ts - now <= warnWithinHours * 60 * 60 * 1000) {
      tone = "amber";
    }
  }

  return (
    <span
      className={cn(
        className,
        tone === "amber" && "text-amber-400",
        tone === "rose" && "text-rose-400",
      )}
      title={date.toISOString()}
    >
      {formatDistanceToNow(date, { addSuffix: suffix })}
    </span>
  );
}

export function AbsoluteTime({
  value,
  fallback = "—",
  className,
}: {
  value: string | null | undefined;
  fallback?: string;
  className?: string;
}) {
  if (!value) return <span className={className}>{fallback}</span>;
  const date = parseISO(value);
  if (!isValid(date)) return <span className={className}>{fallback}</span>;
  return (
    <span className={className} title={date.toISOString()}>
      {date.toISOString().replace(".000Z", "Z")}
    </span>
  );
}
