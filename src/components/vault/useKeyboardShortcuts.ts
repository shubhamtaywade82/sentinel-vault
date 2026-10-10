"use client";

import { useEffect } from "react";
import type { VaultView } from "./store";

/**
 * Global keyboard shortcuts for the vault dashboard.
 * - `?` : show shortcuts help (cycles — opens/closes a help dialog via callback)
 * - `g` then `d/s/c/r/a/l/g/w` : navigate to a view (dashboard/secrets/clients/connections/audit/grants/leases/workspaces)
 * - `r` : refresh data
 * - `w` : run watchdog
 * Single-key shortcuts only fire when NOT typing in an input/textarea/select.
 */
const G_MAP: Record<string, VaultView> = {
  d: "dashboard",
  s: "secrets",
  c: "clients",
  r: "connections",
  a: "audit",
  g: "grants",
  l: "leases",
  w: "workspaces",
};

export function useKeyboardShortcuts(opts: {
  setView: (v: VaultView) => void;
  refresh: () => void;
  runWatchdog: () => void;
  toggleHelp: () => void;
}) {
  useEffect(() => {
    let gPressed = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    function isTypingTarget(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName.toLowerCase();
      return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
    }

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      // `g` prefix navigation
      if (e.key === "g" && !gPressed) {
        gPressed = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => {
          gPressed = false;
        }, 800);
        return;
      }
      if (gPressed) {
        const view = G_MAP[e.key.toLowerCase()];
        if (view) {
          e.preventDefault();
          opts.setView(view);
        }
        gPressed = false;
        if (gTimer) clearTimeout(gTimer);
        return;
      }

      // Single-key shortcuts
      switch (e.key.toLowerCase()) {
        case "?":
          e.preventDefault();
          opts.toggleHelp();
          break;
        case "r":
          if (!gPressed) {
            e.preventDefault();
            opts.refresh();
          }
          break;
        case "w":
          if (!gPressed) {
            e.preventDefault();
            opts.runWatchdog();
          }
          break;
      }
    }

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [opts]);
}

export const SHORTCUTS_HELP: { keys: string; action: string }[] = [
  { keys: "⌘ K", action: "Open command palette" },
  { keys: "g d", action: "Go to Dashboard" },
  { keys: "g s", action: "Go to Secrets" },
  { keys: "g c", action: "Go to Service Clients" },
  { keys: "g r", action: "Go to Connections" },
  { keys: "g a", action: "Go to Audit Log" },
  { keys: "g g", action: "Go to Access Grants" },
  { keys: "g l", action: "Go to Leases" },
  { keys: "g w", action: "Go to Workspaces" },
  { keys: "r", action: "Refresh data" },
  { keys: "w", action: "Run watchdog" },
  { keys: "?", action: "Toggle this help" },
];
