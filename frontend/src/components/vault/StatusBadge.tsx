"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type StatusTone =
  | "emerald"
  | "amber"
  | "rose"
  | "zinc"
  | "teal"
  | "sky"
  | "violet";

const toneClasses: Record<StatusTone, string> = {
  // R3 polish: frosted-glass pill — translucent tinted bg + matching border +
  // backdrop-blur. Reads as a glass chip rather than a flat colored block.
  emerald:
    "border-emerald-500/30 bg-emerald-500/[0.12] text-emerald-300 [backdrop-filter:blur(4px)]",
  amber:
    "border-amber-500/30 bg-amber-500/[0.12] text-amber-300 [backdrop-filter:blur(4px)]",
  rose:
    "border-rose-500/30 bg-rose-500/[0.12] text-rose-300 [backdrop-filter:blur(4px)]",
  zinc:
    "border-zinc-500/30 bg-zinc-500/[0.12] text-zinc-300 [backdrop-filter:blur(4px)]",
  teal:
    "border-teal-500/30 bg-teal-500/[0.12] text-teal-300 [backdrop-filter:blur(4px)]",
  sky:
    "border-sky-500/30 bg-sky-500/[0.12] text-sky-300 [backdrop-filter:blur(4px)]",
  violet:
    "border-violet-500/30 bg-violet-500/[0.12] text-violet-300 [backdrop-filter:blur(4px)]",
};

/**
 * Map a free-form status string to a tonal badge for the vault UI.
 * Palette: emerald (active/safe), amber (warning/refreshing),
 * rose (revoked/error/failed), zinc (neutral/expired), teal/sky (pending).
 */
export function statusTone(status: string | null | undefined): StatusTone {
  if (!status) return "zinc";
  const s = status.toLowerCase();
  if (s === "active" || s === "succeeded" || s === "alive" || s === "ready")
    return "emerald";
  if (
    s === "refreshing" ||
    s === "running" ||
    s === "rotating" ||
    s === "reauth_required" ||
    s === "reauthorize"
  )
    return "amber";
  if (
    s === "revoked" ||
    s === "error" ||
    s === "failed" ||
    s === "destroyed" ||
    s === "denied"
  )
    return "rose";
  if (s === "expired" || s === "retired" || s === "cancelled") return "zinc";
  if (s === "pending") return "teal";
  if (s === "suspended" || s === "archived") return "zinc";
  // classification & kinds fall-through
  if (s === "restricted") return "rose";
  if (s === "confidential") return "amber";
  if (s === "internal") return "teal";
  if (s === "public") return "zinc";
  return "zinc";
}

/**
 * Statuses that represent in-flight or attention-seeking states — they pulse
 * subtly to draw the operator's eye.
 */
const PULSE_STATUSES = new Set([
  "reauth_required",
  "refreshing",
  "running",
  "rotating",
  "pending",
]);

export function StatusBadge({
  status,
  className,
  children,
}: {
  status?: string | null | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  const value = (status ?? "").toString();
  const tone = statusTone(value);
  const pulse = PULSE_STATUSES.has(value.toLowerCase());
  return (
    <Badge
      variant="outline"
      data-status={value || undefined}
      className={cn(
        "border font-mono text-[10px] uppercase tracking-wide",
        toneClasses[tone],
        pulse && "vault-pulse",
        className,
      )}
    >
      {children ?? (value || "unknown")}
    </Badge>
  );
}

export function ToneBadge({
  tone,
  children,
  className,
}: {
  tone: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "border font-mono text-[10px] uppercase tracking-wide",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}
