"use client";

import { Card } from "@/components/ui/card";
import { type LucideIcon, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { type ReactNode } from "react";

export function StatCard({
  label,
  value,
  icon: Icon,
  accent = "emerald",
  hint,
  sub,
  loading = false,
  onClick,
}: {
  label: string;
  value: ReactNode;
  icon?: LucideIcon;
  accent?: "emerald" | "amber" | "rose" | "teal" | "zinc" | "sky";
  hint?: ReactNode;
  /**
   * Optional small sub-line below the big number (e.g. "of 6", "in last 24h",
   * "needs attention"). When omitted, an empty-height placeholder is rendered
   * so every card stays the same height and aligns in the grid.
   */
  sub?: ReactNode;
  loading?: boolean;
  /**
   * R10: optional click handler. When provided the whole card becomes a
   * keyboard-accessible button (role="button" tabIndex={0}) with Enter/Space
   * activation, a cursor-pointer, and a subtle ChevronRight affordance that
   * fades in on hover (top-right corner) to signal clickability. Used by the
   * dashboard KPI grid to navigate to the relevant view (e.g. "Total Secrets"
   * → secrets view, "Reauth Required" → connections view).
   */
  onClick?: () => void;
}) {
  const accentText: Record<string, string> = {
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    rose: "text-rose-400",
    teal: "text-teal-400",
    sky: "text-sky-400",
    zinc: "text-zinc-400",
  };
  const accentBar: Record<string, string> = {
    emerald: "bg-emerald-500",
    amber: "bg-amber-500",
    rose: "bg-rose-500",
    teal: "bg-teal-500",
    sky: "bg-sky-500",
    zinc: "bg-zinc-500",
  };
  // R4 polish: ambient glow color per accent — emitted as a soft halo from the
  // left accent bar. Subtle (~15% alpha) so it reads as ambient light, not a
  // distracting blob. Zinc is dimmer (10%) since it's the neutral tone.
  const accentGlow: Record<string, string> = {
    emerald: "rgba(16,185,129,0.15)",
    amber: "rgba(245,158,11,0.15)",
    rose: "rgba(244,63,94,0.15)",
    sky: "rgba(56,189,248,0.15)",
    teal: "rgba(20,184,166,0.15)",
    zinc: "rgba(161,161,170,0.10)",
  };

  // Prefer the explicit `sub` prop, fall back to legacy `hint`.
  const subLine = sub ?? hint;

  // R5 polish: Reauth Required attention glow — when the card is accent=rose
  // and the value is a positive number (reauth count > 0), set data-attention
  // so the CSS layer adds a soft rose ambient glow + inset border that
  // "breathes" attention without being aggressive. Subtle (~8% outer glow,
  // ~15% inset border). Other accents never set this attribute.
  const numericValue = typeof value === "number" ? value : NaN;
  const attention = accent === "rose" && numericValue > 0;

  const clickable = typeof onClick === "function";

  // R10: keyboard activation for the clickable card. Enter and Space both
  // trigger the onClick; Space is preventDefault'd so the page doesn't
  // scroll. Mirrors native <button> behavior on a div with role="button".
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!clickable) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick!();
    }
  };

  return (
    <Card
      className={cn(
        "vault-card vault-card-interactive group relative overflow-hidden rounded-lg border-zinc-800 p-5",
        // R6 polish: gradient alert border (rose → amber) for reauth cards
        // with value > 0 — added in addition to the data-attention glow so
        // critical alerts stand out more without being garish.
        attention && "vault-alert-border",
        // R10: clickable KPI affordance — cursor + hover lift (already from
        // vault-card-interactive) + group for the chevron's group-hover.
        clickable && "cursor-pointer",
      )}
      style={{ "--accent-glow": accentGlow[accent] } as React.CSSProperties}
      data-attention={attention ? "true" : undefined}
      onClick={clickable ? onClick : undefined}
      onKeyDown={clickable ? handleKeyDown : undefined}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `${label} — open` : undefined}
    >
      <div
        className={cn(
          "vault-ambient-glow absolute left-0 top-0 h-full w-0.5",
          accentBar[accent],
        )}
      />
      {/* R10: clickable affordance — a subtle ChevronRight fades in on hover
          in the top-right corner to signal the card is navigable. Only
          rendered when onClick is provided. pointer-events-none so it never
          steals clicks from the card's onClick. Positioned at the extreme
          corner (top-1.5 right-1.5) so it doesn't overlap the accent icon
          (which sits ~20px inset via the card's p-5 padding). */}
      {clickable && (
        <ChevronRight
          className="pointer-events-none absolute right-1.5 top-1.5 size-3 text-zinc-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          aria-hidden
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400 opacity-60">
          {label}
        </span>
        {Icon && (
          <Icon
            className={cn("mt-0.5 size-4", accentText[accent])}
            aria-hidden
          />
        )}
      </div>
      {/* R11 Bug 1: wrap value + sub in a left-aligned flex column so the
          big number and the sub-line stay strictly stacked on the left edge,
          regardless of the surrounding label/icon row (which uses
          justify-between). Previously the sub-line sometimes appeared
          visually pushed to the right because the Card's `flex flex-col`
          gave each child block-level width, but no explicit items-start
          anchor — this guarantees alignment for cards with single-digit
          values like "Active Clients" (5) + sub "5 active · 0 revoked".
          gap-1.5 replaces the prior mt-2/mt-3 margins so the value+sub sit
          as a tight group beneath the label. */}
      <div className="mt-3 flex flex-col items-start gap-1.5">
        {loading ? (
          <div className="h-8 w-20 animate-pulse rounded-md bg-zinc-800" />
        ) : (
          <div className="bg-gradient-to-b from-white to-zinc-400 bg-clip-text text-left font-mono text-3xl font-bold tabular-nums text-transparent">
            {value}
          </div>
        )}
        {/* Sub-line placeholder keeps every card the same height and aligned.
            R11 Bug 1: bumped text-[10px] (was text-xs) so the sub reads as
            secondary metadata, clearly smaller than the big number above. */}
        <div className="min-h-[14px] text-left text-[10px] text-zinc-500">
          {subLine ?? "\u00A0"}
        </div>
      </div>
    </Card>
  );
}
