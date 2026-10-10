"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Cable,
  KeyRound,
  LayoutDashboard,
  RefreshCw,
  Search,
  ShieldCheck,
  Timer,
  Users,
  Building2,
  Zap,
  RotateCw,
  ScrollText,
} from "lucide-react";
import { useVaultStore, type VaultView } from "./store";
import { api } from "@/lib/vault/client";
import { toast } from "sonner";

interface Command {
  id: string
  label: string
  hint?: string
  icon: React.ComponentType<{ className?: string }>
  group: "Navigate" | "Actions"
  action: () => void
  keywords?: string[]
}

/**
 * Command Palette — Cmd+K / Ctrl+K power-user quick-actions.
 * Fuzzy search across navigation + actions. Keyboard-navigable.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const setView = useVaultStore((s) => s.setView);
  const refresh = useVaultStore((s) => s.refresh);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const navItems: { view: VaultView; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { view: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { view: "secrets", label: "Secrets", icon: KeyRound },
    { view: "clients", label: "Service Clients", icon: Users },
    { view: "connections", label: "Connections", icon: Cable },
    { view: "runs", label: "Rotation Runs", icon: RotateCw },
    { view: "audit", label: "Audit Log", icon: ScrollText },
    { view: "grants", label: "Access Grants", icon: ShieldCheck },
    { view: "leases", label: "Leases", icon: Timer },
    { view: "workspaces", label: "Workspaces", icon: Building2 },
  ];

  async function runWatchdog() {
    try {
      const res = await api.runWatchdog();
      toast.success(
        `Watchdog ticked — checked ${res.checked}, refreshed ${res.refreshed.length}, reauth ${res.reauthRequired.length}, errors ${res.errors.length}`,
      );
      refresh();
    } catch (e) {
      toast.error(`Watchdog failed: ${(e as Error).message}`);
    }
  }

  const commands: Command[] = useMemo(() => {
    const nav: Command[] = navItems.map((n) => ({
      id: `nav-${n.view}`,
      label: n.label,
      hint: "Navigate",
      icon: n.icon,
      group: "Navigate" as const,
      action: () => {
        setView(n.view);
        onOpenChange(false);
      },
      keywords: ["go", "navigate", n.view],
    }));
    const actions: Command[] = [
      {
        id: "refresh",
        label: "Refresh Data",
        hint: "r",
        icon: RefreshCw,
        group: "Actions",
        action: () => {
          refresh();
          onOpenChange(false);
          toast.success("Data refreshed");
        },
        keywords: ["reload", "sync"],
      },
      {
        id: "watchdog",
        label: "Run Watchdog",
        hint: "w",
        icon: Zap,
        group: "Actions",
        action: () => {
          onOpenChange(false);
          runWatchdog();
        },
        keywords: ["refresh", "credentials", "tick"],
      },
    ];
    return [...nav, ...actions];
  }, [setView, refresh, onOpenChange]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.hint ?? ""} ${c.group} ${(c.keywords ?? []).join(" ")}`.toLowerCase();
      return q.split(/\s+/).every((word) => hay.includes(word));
    });
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  function onKeydown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[selectedIndex]?.action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  if (!open) return null;

  const grouped = filtered.reduce<Record<string, Command[]>>((acc, c) => {
    (acc[c.group] ??= []).push(c);
    return acc;
  }, {});

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/85 backdrop-blur-sm"
      onClick={() => onOpenChange(false)}
    >
      <div
        className="vault-card mt-[15vh] w-full max-w-lg overflow-hidden rounded-lg border-zinc-800 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeydown}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <Search className="size-4 text-zinc-500" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto p-2 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-zinc-500">
              No commands match &ldquo;{query}&rdquo;
            </div>
          ) : (
            Object.entries(grouped).map(([group, cmds]) => (
              <div key={group} className="mb-1">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
                  {group}
                </div>
                {cmds.map((c) => {
                  const idx = flatIndex++;
                  const selected = idx === selectedIndex;
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.id}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={c.action}
                      className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors ${
                        selected
                          ? "bg-emerald-500/10 text-emerald-100 ring-1 ring-emerald-500/20"
                          : "text-zinc-300 hover:bg-zinc-800/50"
                      }`}
                    >
                      <Icon className={`size-4 ${selected ? "text-emerald-400" : "text-zinc-500"}`} />
                      <span className="flex-1">{c.label}</span>
                      {c.hint && (
                        <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                          {c.hint}
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2 text-[10px] text-zinc-600">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 text-zinc-400">↑</kbd>
              <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 text-zinc-400">↓</kbd>
              navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 text-zinc-400">↵</kbd>
              select
            </span>
          </div>
          <span className="font-mono">{filtered.length} commands</span>
        </div>
      </div>
    </div>
  );
}
