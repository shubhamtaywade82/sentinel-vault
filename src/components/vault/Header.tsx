"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Ban,
  Loader2,
  Menu,
  RefreshCw,
  ShieldCheck,
  UserCog,
  Users,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/lib/vault/client";
import { useVaultStore } from "./store";
import { Sidebar } from "./Sidebar";
import { IdentitySwitcherDialog } from "./IdentitySwitcherDialog";
import { cn } from "@/lib/utils";

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const setWorkspaceId = useVaultStore((s) => s.setWorkspaceId);
  const refresh = useVaultStore((s) => s.refresh);
  const authMode = useVaultStore((s) => s.authMode);
  const clientName = useVaultStore((s) => s.clientName);
  const clientPublicId = useVaultStore((s) => s.clientPublicId);
  const exitClientView = useVaultStore((s) => s.exitClientView);
  const qc = useQueryClient();

  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });

  const health = useQuery({
    queryKey: ["health", "live"],
    queryFn: () => api.healthLive(),
    refetchInterval: 30_000,
  });

  const selectedWorkspaceSlug = useMemo(() => {
    const list = workspaces.data?.workspaces ?? [];
    if (!workspaceId) return null;
    return list.find((w) => w.id === workspaceId)?.slug ?? null;
  }, [workspaces.data, workspaceId]);
  const isProduction = selectedWorkspaceSlug === "production";

  useEffect(() => {
    if (!workspaceId && workspaces.data?.workspaces?.length) {
      const prod = workspaces.data.workspaces.find(
        (w) => w.slug === "production",
      );
      setWorkspaceId((prod ?? workspaces.data.workspaces[0]).id);
    }
  }, [workspaceId, workspaces.data, setWorkspaceId]);

  async function onRunWatchdog() {
    try {
      const res = await api.runWatchdog();
      toast.success(
        `Watchdog ticked — checked ${res.checked}, refreshed ${res.refreshed.length}, reauth ${res.reauthRequired.length}, errors ${res.errors.length}`,
      );
      refresh();
    } catch (e) {
      toast.error(`Watchdog failed: ${(e as Error).message}`, {
        description: "Backend may still be warming up — try again later.",
      });
    }
  }

  function onExitClient() {
    exitClientView();
    qc.invalidateQueries();
    toast.success("Returned to admin view");
  }

  const healthOk =
    health.data?.status === "alive" || health.data?.status === "ready";

  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2 border-b border-zinc-800 bg-[#0a0b0f]/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-[#0a0b0f]/80 sm:px-4">
      <div className="flex items-center gap-2 md:hidden">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation menu"
              className="min-h-11 min-w-11 text-zinc-300 hover:bg-zinc-800/60"
            >
              <Menu className="size-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="w-72 border-r border-zinc-800 bg-zinc-950 p-0 text-zinc-100"
          >
            {/* Accessible title/description for screen readers (visually hidden;
                the brand block below is the visual equivalent). Required by
                Radix Dialog primitive to avoid the "DialogContent requires a
                DialogTitle" accessibility warning. */}
            <SheetTitle className="sr-only">Sentinel Vault navigation</SheetTitle>
            <SheetDescription className="sr-only">
              Primary navigation for the vault dashboard views.
            </SheetDescription>
            <div className="flex h-14 items-center gap-2 border-b border-zinc-800 px-4">
              <ShieldCheck className="size-5 text-emerald-400" />
              <span className="font-semibold tracking-tight">
                Sentinel Vault
              </span>
            </div>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      </div>

      <div className="hidden h-9 w-9 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/30 sm:flex md:flex">
        <ShieldCheck className="size-5" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          Sentinel Vault
        </span>
        <span className="hidden text-[11px] text-zinc-500 sm:inline">
          Secrets Operations Console
        </span>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <div
          className={cn(
            "hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono sm:flex",
            healthOk
              ? "border-emerald-700/40 bg-emerald-500/10 text-emerald-300"
              : "border-zinc-800 bg-zinc-900/60 text-zinc-400",
          )}
          aria-label="Health status"
          title={health.isError ? "Backend unreachable" : "Backend healthy"}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              healthOk
                ? "bg-emerald-400 vault-health-pulse"
                : "bg-zinc-500",
            )}
          />
          {health.isError ? "offline" : health.data?.status ?? "…"}
        </div>

        {authMode === "admin" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIdentityOpen(true)}
            className="min-h-11 border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="View as Client — switch identity"
            title="Switch to a service-client identity to preview least-privilege"
          >
            <Users className="size-3.5 text-amber-400" />
            <span className="hidden md:inline">View as Client</span>
          </Button>
        ) : (
          <div className="flex items-center gap-1">
            <div
              className="flex min-h-11 items-center gap-1.5 rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-xs text-amber-200"
              title={`Impersonating ${clientName} (${clientPublicId})`}
            >
              <UserCog className="size-3.5 text-amber-400" />
              <span className="hidden sm:inline font-mono">{clientName}</span>
              <span className="hidden lg:inline text-[10px] text-amber-400/70 font-mono">
                {clientPublicId}
              </span>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={onExitClient}
              aria-label="Exit client view"
              title="Exit client view — return to admin"
              className="min-h-11 min-w-11 border-amber-700/50 bg-amber-950/40 text-amber-200 hover:bg-amber-900/50 hover:text-amber-100"
            >
              <Ban className="size-4" />
            </Button>
          </div>
        )}

        <Select
          value={workspaceId || "all"}
          onValueChange={(v) => setWorkspaceId(v === "all" ? "" : v)}
          disabled={authMode === "client"}
        >
          <SelectTrigger
            className={cn(
              "h-9 w-[150px] min-h-11 border text-xs transition-colors",
              authMode === "client"
                ? "border-zinc-800 bg-zinc-900/40 text-zinc-500 cursor-not-allowed"
                : isProduction
                  ? "border-emerald-800/50 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-950/50"
                  : "border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800/60",
            )}
            aria-label="Workspace selector"
            title={
              authMode === "client"
                ? "Workspace selector locked — client view is scoped to the client's own workspace"
                : isProduction
                  ? "Production workspace — destructive actions apply to live secrets"
                  : "Workspace selector"
            }
          >
            <SelectValue placeholder="Workspace" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
            <SelectItem value="all">All workspaces</SelectItem>
            {workspaces.data?.workspaces?.map((w) => (
              <SelectItem key={w.id} value={w.id}>
                <span className="font-mono">{w.slug}</span>
                <span className="ml-2 text-zinc-500">· {w.name}</span>
              </SelectItem>
            )) ?? (
              <SelectItem value="__loading" disabled>
                Loading…
              </SelectItem>
            )}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          onClick={onRunWatchdog}
          className="min-h-11 border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
          aria-label="Run watchdog now"
        >
          <Zap className="size-3.5 text-amber-400" />
          <span className="hidden md:inline">Run Watchdog</span>
        </Button>

        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh data"
          onClick={() => refresh()}
          className="min-h-11 min-w-11 text-zinc-300 hover:bg-zinc-800/60"
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>

      <HealthBadge />

      <IdentitySwitcherDialog
        open={identityOpen}
        onOpenChange={setIdentityOpen}
        workspaceId={workspaceId}
      />
    </header>
  );
}

function HealthBadge() {
  const adminToken = useVaultStore((s) => s.adminToken);
  const authMode = useVaultStore((s) => s.authMode);
  const adminSet = !!adminToken;
  if (authMode === "client") {
    return (
      <div
        className="ml-1 hidden items-center gap-1 rounded-md border border-amber-700/50 bg-amber-950/40 px-2 py-1 text-[10px] font-mono text-amber-200 lg:flex"
        title="Impersonating a service client"
      >
        <Loader2 className="size-3 text-amber-400" />
        client view
      </div>
    );
  }
  return (
    <div
      className="ml-1 hidden items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1 text-[10px] font-mono text-zinc-400 lg:flex"
      title="Admin token presence"
    >
      {adminSet ? (
        <>
          <Activity className="size-3 text-emerald-400" />
          admin-token set
        </>
      ) : (
        <>
          <AlertTriangle className="size-3 text-amber-400" />
          no admin token
        </>
      )}
    </div>
  );
}
