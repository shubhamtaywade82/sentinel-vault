"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Keyboard } from "lucide-react";

import { Providers } from "@/components/vault/providers";
import { Header } from "@/components/vault/Header";
import { Footer } from "@/components/vault/Footer";
import { Sidebar } from "@/components/vault/Sidebar";
import { IdentityBanner } from "@/components/vault/IdentityBanner";
import { CommandPalette } from "@/components/vault/CommandPalette";
import { useVaultStore, syncAdminTokenToLocalStorage } from "@/components/vault/store";
import { useKeyboardShortcuts, SHORTCUTS_HELP } from "@/components/vault/useKeyboardShortcuts";
import { api } from "@/lib/vault/client";

// Lazy-load all views so Turbopack compiles them on-demand instead of all at
// once. This keeps peak compilation memory low enough for the 4GB sandbox.
const ViewFallback = () => (
  <div className="flex h-64 items-center justify-center text-zinc-500">
    <Loader2 className="size-5 animate-spin" />
  </div>
);
const DashboardView = dynamic(
  () => import("@/components/vault/views/DashboardView").then((m) => m.DashboardView),
  { loading: () => <ViewFallback /> },
);
const SecretsView = dynamic(
  () => import("@/components/vault/views/SecretsView").then((m) => m.SecretsView),
  { loading: () => <ViewFallback /> },
);
const ServiceClientsView = dynamic(
  () => import("@/components/vault/views/ServiceClientsView").then((m) => m.ServiceClientsView),
  { loading: () => <ViewFallback /> },
);
const ConnectionsView = dynamic(
  () => import("@/components/vault/views/ConnectionsView").then((m) => m.ConnectionsView),
  { loading: () => <ViewFallback /> },
);
const RotationRunsView = dynamic(
  () => import("@/components/vault/views/RotationRunsView").then((m) => m.RotationRunsView),
  { loading: () => <ViewFallback /> },
);
const AuditView = dynamic(
  () => import("@/components/vault/views/AuditView").then((m) => m.AuditView),
  { loading: () => <ViewFallback /> },
);
const AccessGrantsView = dynamic(
  () => import("@/components/vault/views/AccessGrantsView").then((m) => m.AccessGrantsView),
  { loading: () => <ViewFallback /> },
);
const LeasesView = dynamic(
  () => import("@/components/vault/views/LeasesView").then((m) => m.LeasesView),
  { loading: () => <ViewFallback /> },
);
const WorkspacesView = dynamic(
  () => import("@/components/vault/views/WorkspacesView").then((m) => m.WorkspacesView),
  { loading: () => <ViewFallback /> },
);

export default function Page() {
  return (
    <Providers>
      <DashboardShell />
    </Providers>
  );
}

function DashboardShell() {
  const view = useVaultStore((s) => s.view);
  const setView = useVaultStore((s) => s.setView);
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const setWorkspaceId = useVaultStore((s) => s.setWorkspaceId);
  const adminToken = useVaultStore((s) => s.adminToken);
  const authMode = useVaultStore((s) => s.authMode);
  const refresh = useVaultStore((s) => s.refresh);
  const qc = useQueryClient();
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  // Cmd+K / Ctrl+K to open the command palette
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useKeyboardShortcuts({
    setView,
    refresh,
    runWatchdog,
    toggleHelp: () => setHelpOpen((v) => !v),
  });

  // Mirror admin token to localStorage so the API client reads it.
  useEffect(() => {
    syncAdminTokenToLocalStorage(adminToken);
  }, [adminToken]);

  // Bootstrap: list workspaces, seed if empty, pick production if possible.
  const seededRef = useRef(false);
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });

  useEffect(() => {
    if (workspacesQ.status === "pending" || seededRef.current) return;
    if (workspacesQ.status === "error") return;
    const list = workspacesQ.data?.workspaces ?? [];
    if (list.length === 0) {
      seededRef.current = true;
      (async () => {
        try {
          await api.seed();
          toast.success("Vault seeded with demo data");
          qc.invalidateQueries({ queryKey: ["workspaces"] });
        } catch {
          // Backend not ready — fail silently, the dashboard handles 404s.
        }
      })();
      return;
    }
    // Pick "production" if no workspace selected.
    if (!workspaceId) {
      const prod = list.find((w) => w.slug === "production");
      setWorkspaceId((prod ?? list[0]).id);
    }
    seededRef.current = true;
  }, [workspacesQ.status, workspacesQ.data, workspaceId, setWorkspaceId, qc]);

  // When entering client view, the workspace selector is locked to the
  // client's own workspace (the /me endpoint reveals it). When exiting,
  // restore the admin's last selection (already in store).
  const meQ = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    enabled: authMode === "client",
    staleTime: 30_000,
  });

  useEffect(() => {
    if (authMode === "client" && meQ.data?.client?.workspaceId) {
      const clientWs = meQ.data.client.workspaceId;
      if (clientWs && clientWs !== workspaceId) {
        setWorkspaceId(clientWs);
      }
    }
  }, [authMode, meQ.data, workspaceId, setWorkspaceId]);

  return (
    <div className="flex min-h-screen flex-col bg-[#0a0b0f] text-zinc-100">
      <Header />
      <IdentityBanner />
      <div className="flex flex-1 overflow-hidden">
        <aside className="hidden w-64 shrink-0 border-r border-zinc-800 bg-zinc-950 md:flex">
          <Sidebar />
        </aside>
        <main className="flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8">
          <ViewRouter view={view} />
        </main>
      </div>
      <Footer />

      {/* Keyboard shortcuts help dialog (triggered by `?`) */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="vault-card w-full max-w-md rounded-lg border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-2">
              <Keyboard className="size-4 text-emerald-400" />
              <h2 className="text-sm font-semibold text-zinc-100">
                Keyboard Shortcuts
              </h2>
              <kbd className="ml-auto rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                ?
              </kbd>
            </div>
            <div className="space-y-1.5">
              {SHORTCUTS_HELP.map((s) => (
                <div
                  key={s.keys}
                  className="flex items-center justify-between gap-3 text-xs"
                >
                  <span className="text-zinc-400">{s.action}</span>
                  <span className="flex shrink-0 gap-1">
                    {s.keys.split(" ").map((k, i) => (
                      <kbd
                        key={i}
                        className="rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                      >
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-4 border-t border-zinc-800 pt-3 text-[10px] text-zinc-500">
              Shortcuts are disabled while typing in inputs.
            </p>
          </div>
        </div>
      )}

      {/* Command Palette (triggered by Cmd+K / Ctrl+K) */}
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}

function ViewRouter({ view }: { view: string }) {
  switch (view) {
    case "dashboard":
      return <DashboardView />;
    case "secrets":
      return <SecretsView />;
    case "clients":
      return <ServiceClientsView />;
    case "connections":
      return <ConnectionsView />;
    case "runs":
      return <RotationRunsView />;
    case "audit":
      return <AuditView />;
    case "grants":
      return <AccessGrantsView />;
    case "leases":
      return <LeasesView />;
    case "workspaces":
      return <WorkspacesView />;
    default:
      return <DashboardView />;
  }
}
