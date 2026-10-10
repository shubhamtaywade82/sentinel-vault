"use client";

import { Database, KeyRound, ShieldCheck } from "lucide-react";

/**
 * R10 Bug 2: bumped all footer text colors up one step for WCAG AA on the
 *   #0a0b0f dark background. zinc-500→zinc-400 (left), zinc-600→zinc-500
 *   (center), zinc-400→zinc-300 (right), zinc-700→zinc-600 (separators).
 *   zinc-400 on #0a0b0f is ~7:1 (passes AA for normal text). The emerald
 *   breathing dot stays.
 * R5 polish: 3-section footer with clear visual hierarchy.
 *   Left:   version info       — text-zinc-400 (faded — least important)
 *   Center: security context   — text-zinc-500 (mid-tier, hidden on mobile)
 *   Right:  runtime status     — text-zinc-300 (brightest — most important)
 * `gap-x-6` between the 3 sections; `·` separators within each section
 * in text-zinc-600. Emerald breathing dot stays on the status block.
 */
export function Footer() {
  return (
    <footer className="vault-footer-fade relative mt-auto flex flex-col items-center gap-x-6 gap-2 border-t border-zinc-800/40 bg-[#0a0b0f]/95 px-4 py-2.5 text-[11px] shadow-[0_-1px_8px_0_rgb(0_0_0/0.3)] backdrop-blur supports-[backdrop-filter]:bg-[#0a0b0f]/80 sm:flex-row sm:justify-between pb-[env(safe-area-inset-bottom)]">
      {/* Left: version info */}
      <div className="relative flex items-center gap-x-2 font-mono text-zinc-400">
        <ShieldCheck className="size-3.5 text-emerald-500/70" />
        <span>Sentinel Vault v0.1</span>
        <span aria-hidden className="text-zinc-600">·</span>
        <span>demo build</span>
      </div>

      {/* Center: security architecture context (hidden below lg) */}
      <div className="relative hidden items-center gap-x-2 font-mono text-zinc-500 lg:flex">
        <span>Workspace-isolated</span>
        <span aria-hidden className="text-zinc-600">·</span>
        <span>AES-256-GCM envelope</span>
        <span aria-hidden className="text-zinc-600">·</span>
        <span>audit-grade</span>
      </div>

      {/* Right: runtime status */}
      <div className="relative flex items-center gap-x-2 font-mono text-zinc-300">
        <KeyRound className="size-3.5 text-amber-500/70" />
        <span>KMS: local-master-v1</span>
        <span aria-hidden className="text-zinc-600">·</span>
        <Database className="size-3.5 text-emerald-500/70" />
        <span>DB: sqlite</span>
        <span aria-hidden className="text-zinc-600">·</span>
        <span className="flex items-center gap-x-1 text-emerald-400">
          <span className="size-1.5 rounded-full bg-emerald-400 vault-health-pulse" />
          Status: nominal
        </span>
      </div>
    </footer>
  );
}
