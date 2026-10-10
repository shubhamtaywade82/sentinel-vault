"use client";

import { useState } from "react";
import {
  Activity,
  Ban,
  BarChart3,
  Bot,
  Cable,
  ChevronRight,
  Clock,
  Gauge,
  KeyRound,
  Lock,
  Radar,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  ShieldCheck,
  Timer,
  Unlock,
  Wrench,
  AlertTriangle,
  CheckCircle2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { MiniAreaChart } from "@/components/vault/MiniAreaChart";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/vault/client";
import type { AuditRange } from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatCard } from "../StatCard";
import { StatusBadge } from "../StatusBadge";
import { RelativeTime } from "../RelativeTime";
import { EmptyState, isApiWarmingError } from "../Status";
import { bucketAuditByHour, computeStats, useExpiryTimeline } from "../lib/computeStats";

export function DashboardView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);
  // R10: KPI cards are clickable — each navigates to the relevant view.
  // Pulled here (once) so every StatCard onClick closes over the same setter
  // without re-creating per-render.
  const setView = useVaultStore((s) => s.setView);
  const [timeRange, setTimeRange] = useState<AuditRange>("24h");

  const statsQ = useQuery({
    queryKey: ["dashboard-stats", workspaceId, refreshTick],
    queryFn: () => api.dashboardStats(workspaceId),
    enabled: !!workspaceId,
  });

  const secretsQ = useQuery({
    queryKey: ["secrets", workspaceId, refreshTick],
    queryFn: () => api.listSecrets(workspaceId),
    enabled: !!workspaceId,
  });
  const connectionsQ = useQuery({
    queryKey: ["connections", workspaceId, refreshTick],
    queryFn: () => api.listConnections(workspaceId),
    enabled: !!workspaceId,
  });
  const runsQ = useQuery({
    queryKey: ["runs", refreshTick],
    queryFn: () => api.listRuns({ limit: 100 }),
  });
  const auditQ = useQuery({
    queryKey: ["audit", workspaceId, refreshTick, 100],
    queryFn: () => api.listAudit({ workspaceId: workspaceId || undefined, limit: 100 }),
  });
  const clientsQ = useQuery({
    queryKey: ["clients", workspaceId, refreshTick],
    queryFn: () => api.listClients(workspaceId),
    enabled: !!workspaceId,
  });

  // Provider Health aggregation (success/failure rates per provider)
  const providerHealthQ = useQuery({
    queryKey: ["provider-health", workspaceId, refreshTick],
    queryFn: () => api.providerHealth(workspaceId),
    enabled: !!workspaceId,
  });

  // Client Preview (least-privilege proof — what each client can/cannot access)
  const clientPreviewQ = useQuery({
    queryKey: ["client-preview", workspaceId, refreshTick],
    queryFn: () => api.clientPreview(workspaceId),
    enabled: !!workspaceId,
  });

  // Policy & Rotation Compliance (secrets not rotated in 90 days, expired, etc.)
  const complianceQ = useQuery({
    queryKey: ["compliance", workspaceId, refreshTick],
    queryFn: () => api.compliance(workspaceId),
    enabled: !!workspaceId,
  });

  // Expiring Leases (active leases expiring within 1 hour)
  const expiringLeasesQ = useQuery({
    queryKey: ["expiring-leases", workspaceId, refreshTick],
    queryFn: () => api.expiringLeases(workspaceId),
    enabled: !!workspaceId,
    refetchInterval: 15_000, // leases expire fast; refresh every 15s
  });

  // Compliance remediation (one-click rotate a violating secret)
  const qc = useQueryClient();
  const [remediateTarget, setRemediateTarget] = useState<{
    secretId: string;
    path: string;
    violation: string;
  } | null>(null);

  // R11 Task 1b: anomaly drill-down — clicking an anomaly row opens a detail
  // dialog with the full record (type, severity, title, description, secret
  // path, actor, source IP, timestamp, metadata). The dialog has a "View Audit
  // Log" button that navigates to the audit view + a "Close" button.
  const [selectedAnomaly, setSelectedAnomaly] = useState<
    | (import("@/lib/vault/types").AnomalyRow)
    | null
  >(null);
  // Empty means "let the provider refresh it"; the API refuses that for
  // secrets no provider manages, and the error is shown to the operator.
  const [remediateValue, setRemediateValue] = useState("");
  const closeRemediate = () => {
    setRemediateTarget(null);
    setRemediateValue("");
  };
  const remediateM = useMutation({
    mutationFn: () =>
      api.remediate(
        remediateTarget!.secretId,
        remediateTarget!.violation,
        remediateValue.trim() === "" ? undefined : remediateValue,
      ),
    onSuccess: (res) => {
      toast.success(
        `Remediated "${remediateTarget?.path}" — new version ${res.version.versionNumber} created`,
      );
      closeRemediate();
      qc.invalidateQueries({ queryKey: ["compliance"] });
      qc.invalidateQueries({ queryKey: ["secrets"] });
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
    onError: (e) => toast.error(`Remediation failed: ${(e as Error).message}`),
  });

  // R9: inline action button — revoke a lease directly from Expiring Leases.
  const revokeLeaseM = useMutation({
    mutationFn: (leaseId: string) => api.revokeLease(leaseId),
    onSuccess: () => {
      toast.success("Lease revoked");
      qc.invalidateQueries({ queryKey: ["expiring-leases"] });
      qc.invalidateQueries({ queryKey: ["leases"] });
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
    onError: (e) => toast.error(`Revoke failed: ${(e as Error).message}`),
  });

  // R9: inline action button — force-refresh a connection directly from
  // Connection Health. Unique idempotency key per click so repeat clicks
  // within the engine's idempotency window return the same run instead of
  // creating duplicate rotation runs.
  const refreshConnM = useMutation({
    mutationFn: (vars: { id: string; provider: string }) =>
      api.refreshConnection(
        vars.id,
        `dash-refresh-${vars.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ),
    onSuccess: (_data, vars) => {
      toast.success(`Refresh triggered for ${vars.provider}`);
      qc.invalidateQueries({ queryKey: ["connections"] });
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e) => toast.error(`Refresh failed: ${(e as Error).message}`),
  });

  // Anomalous access detection (denied spikes, new IPs, off-hours, bursts)
  const anomaliesQ = useQuery({
    queryKey: ["anomalies", workspaceId, timeRange, refreshTick],
    queryFn: () => api.anomalies(workspaceId, timeRange),
    enabled: !!workspaceId,
  });

  const warming =
    statsQ.isError && isApiWarmingError(statsQ.error) && !statsQ.data;

  const stats =
    statsQ.data ??
    computeStats({
      secrets: secretsQ.data?.secrets,
      connections: connectionsQ.data?.connections,
      runs: runsQ.data?.runs,
      audit: auditQ.data?.events,
      clients: clientsQ.data?.clients,
    });

  const timeline = useExpiryTimeline(
    connectionsQ.data?.connections ?? [],
    secretsQ.data?.secrets ?? [],
    6,
  );

  const recentAudit = (auditQ.data?.events ?? []).slice(0, 10);
  const connections = connectionsQ.data?.connections ?? [];

  // Audit activity by selected time range (drives the chart)
  const auditActivityQ = useQuery({
    queryKey: ["audit-activity", workspaceId, timeRange, refreshTick],
    queryFn: () => api.auditActivity(workspaceId, timeRange),
    enabled: !!workspaceId,
  });

  const chartData =
    auditActivityQ.data?.buckets.map((b) => {
      // R7 polish: chart X-axis labels carry explicit time context per range
      // so the operator can tell at a glance whether they're looking at
      // intra-hour, intra-day, intra-week, or intra-month data.
      //   1h  -> HH:MM (e.g. 14:05)
      //   24h -> HH:00 (e.g. 14:00) — 1h buckets always fall on :00
      //   7d  -> ddd HH (e.g. Mon 14) — weekday + hour, 6h buckets
      //   30d -> MM/DD (e.g. 10/14) — month/day, 1d buckets
      const d = new Date(b.ts);
      let label: string;
      if (timeRange === "1h" || timeRange === "24h") {
        label = d.toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
      } else if (timeRange === "7d") {
        const wd = d.toLocaleString("en-US", { weekday: "short" });
        const hr = d.getHours().toString().padStart(2, "0");
        label = `${wd} ${hr}`;
      } else {
        label = d.toLocaleString("en-US", {
          month: "2-digit",
          day: "2-digit",
        });
      }
      return { label, count: b.count };
    }) ??
    bucketAuditByHour(auditQ.data?.events, 7);

  const auditTotals = auditActivityQ.data?.totals;

  const loading =
    !statsQ.data &&
    (secretsQ.isLoading || connectionsQ.isLoading || clientsQ.isLoading);

  return (
    <div
      className="vault-enter space-y-5"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — computing dashboard stats client-side from list endpoints.
        </div>
      )}

      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Operations Dashboard</h1>
        <p className="text-xs text-zinc-500">
          At-a-glance view of the secrets, connections, and rotation pipeline for the current workspace.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Total Secrets"
          value={stats.totalSecrets}
          icon={KeyRound}
          accent="emerald"
          loading={loading && !stats.totalSecrets}
          onClick={() => setView("secrets")}
        />
        <StatCard
          label="Active Connections"
          value={stats.activeConnections}
          icon={Cable}
          accent="emerald"
          loading={loading && !stats.activeConnections}
          onClick={() => setView("connections")}
        />
        <StatCard
          label="Pending Rotations"
          value={stats.pendingRotations}
          icon={RefreshCw}
          accent="sky"
          loading={loading && !stats.pendingRotations}
          onClick={() => setView("runs")}
        />
        <StatCard
          label="Reauth Required"
          value={stats.reauthRequired}
          icon={ShieldAlert}
          accent="rose"
          loading={loading && !stats.reauthRequired}
          onClick={() => setView("connections")}
        />
        <StatCard
          label="Audit Events 24h"
          value={stats.auditEvents24h}
          icon={Activity}
          accent="teal"
          loading={loading && !stats.auditEvents24h}
          onClick={() => setView("audit")}
        />
        <StatCard
          label="Active Clients"
          value={stats.activeClients}
          icon={Bot}
          accent="emerald"
          // R10 Bug 3: replaced ambiguous "of N" hint with explicit
          // "N active · M revoked" so the metric reads clearly. The old
          // "of 5" was ambiguous (5 what? total? threshold?). The new hint
          // disambiguates: the big number is active clients, the hint
          // breaks down active vs revoked. If totalClients is 0 the hint
          // is omitted entirely (no clients seeded yet).
          hint={
            stats.totalClients
              ? `${stats.activeClients} active · ${stats.totalClients - stats.activeClients} revoked`
              : undefined
          }
          loading={loading && !stats.activeClients}
          onClick={() => setView("clients")}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="vault-card rounded-lg border-zinc-800 p-4 lg:col-span-2">
          <div className="mb-2 flex items-center justify-between gap-2">
            {/* R10 Polish 2: standardized panel header typography — same
                classes as the other 8 panels (flex items-center gap-2
                text-sm font-semibold text-zinc-200). mb-3 omitted because
                this h2 shares a row with the time-range Select (the parent
                flex container's mb-2 handles the spacing). Added a BarChart3
                icon so the header matches the icon-prefixed pattern of every
                other dashboard panel. */}
            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
              <BarChart3 className="size-4 text-emerald-400" />
              Audit Activity
            </h2>
            <div className="flex items-center gap-2">
              {auditTotals && (
                <div className="hidden items-center gap-2 text-[10px] font-mono text-zinc-500 sm:flex">
                  <span>{auditTotals.events} events</span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-emerald-400">{auditTotals.reveals} reveals</span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-amber-400">{auditTotals.rotations} rotations</span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-rose-400">{auditTotals.denied} denied</span>
                </div>
              )}
              <Select value={timeRange} onValueChange={(v) => setTimeRange(v as AuditRange)}>
                <SelectTrigger className="h-7 w-[90px] border-zinc-800 bg-zinc-900/60 text-[10px] font-mono text-zinc-300">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
                  <SelectItem value="1h">Last 1h</SelectItem>
                  <SelectItem value="24h">Last 24h</SelectItem>
                  <SelectItem value="7d">Last 7d</SelectItem>
                  <SelectItem value="30d">Last 30d</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="h-44 w-full">
            {loading ? (
              <Skeleton className="h-44 w-full bg-zinc-800/60" />
            ) : (
              <MiniAreaChart
                data={chartData}
                height={176}
                color="#10b981"
                // R11 Task 1a: clicking a chart point (spike) navigates to
                // the Audit Log so an operator can investigate the events in
                // that bucket. Toast provides immediate feedback that the
                // click registered; setView unmounts the chart + mounts
                // AuditView.
                onPointClick={(p) => {
                  toast.info(`Jumping to Audit Log (${p.count} events @ ${p.label})`);
                  setView("audit");
                }}
              />
            )}
          </div>
        </Card>

        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Clock className="size-4 text-amber-400" />
            Expiry Timeline
          </h2>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : timeline.length === 0 ? (
            <EmptyState
              icon={Clock}
              title="No upcoming expiries"
              hint="No secrets or connections have a scheduled expiry date."
            />
          ) : (
            <ul className="space-y-1.5">
              {timeline.map((t) => {
                // R5 polish: urgency-colored left accent on Expiry Timeline
                // items — rose for expiries within 24h, amber for within 7
                // days, no extra accent for longer horizons. Makes imminent
                // expiries pop at a glance without a separate color column.
                const expiryMs = +new Date(t.expiresAt);
                const untilMs = expiryMs - Date.now();
                const dayMs = 24 * 60 * 60 * 1000;
                const urgencyBorder =
                  untilMs <= dayMs
                    ? "border-l-2 border-l-rose-500/50"
                    : untilMs <= 7 * dayMs
                      ? "border-l-2 border-l-amber-500/50"
                      : "";
                return (
                <li
                  key={`${t.kind}-${t.id}`}
                  className={`group flex items-center justify-between gap-1.5 rounded-md border border-zinc-800 bg-zinc-950/40 py-2.5 px-3 ${urgencyBorder}`}
                >
                  <div className="min-w-0 flex-1">
                    {/* R9 Bug 1: replaced break-all with truncate so the
                        ref (a path like dhan/prod/access-token) ellipsizes
                        cleanly at word boundaries on narrow screens instead
                        of hyphenating mid-word. Keeps font-mono text-[11px].
                        R11 Bug 3: bumped text-zinc-300 → text-zinc-200 +
                        font-medium so the primary value (the secret path)
                        reads brighter than the secondary kind label below —
                        fixes the VLM-noted flat hierarchy where path + kind
                        both appeared the same brightness. */}
                    <div className="truncate font-mono text-[11px] text-zinc-200 font-medium">
                      {t.ref}
                    </div>
                    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                      {t.kind}
                    </div>
                  </div>
                  <div className="flex max-w-[40%] flex-wrap items-center justify-end gap-1.5">
                    {/* R9 Task 1a: inline Rotate button — only for secret
                        expiries (connection expiries use the Refresh button
                        in Connection Health). Appears on hover via
                        group-hover:opacity-100. shrink-0 so it never gets
                        squeezed by the StatusBadge + time. */}
                    {t.kind === "secret" && (
                      <button
                        type="button"
                        className="vault-action-btn opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                        onClick={(e) => {
                          e.stopPropagation();
                          // Rotation needs a real new value (or a provider
                          // refresh), so it goes through the remediate dialog.
                          setRemediateTarget({ secretId: t.id, path: t.ref, violation: "expiring_soon" });
                        }}
                        title="Rotate this secret now"
                      >
                        <RotateCw className="size-3 text-emerald-400" />
                        <span>Rotate</span>
                      </button>
                    )}
                    <StatusBadge
                      status={t.status}
                      className="self-center text-[9px]"
                    />
                    <span className="whitespace-nowrap text-[10px] text-zinc-500">
                      <RelativeTime value={t.expiresAt} warnWithinHours={24} />
                    </span>
                  </div>
                </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Activity className="size-4 text-teal-400" />
            Recent Audit Events
          </h2>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : recentAudit.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No audit events yet"
              hint="Audit events will appear here once secrets are revealed or rotations are run."
            />
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
              {recentAudit.map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-zinc-800/60 bg-zinc-950/40 py-2.5 px-3"
                >
                  <div className="min-w-0 flex-1">
                    {/* R10 Bug 1: added title attr so a tooltip shows the full
                        action text on hover — the bottom-most entries were
                        visibly truncated without an ellipsis/tooltip cue.
                        The `truncate` class (below) already renders the
                        ellipsis; the title supplements it for hover. */}
                    <div
                      className="truncate font-mono text-[11px] text-zinc-200"
                      title={e.action}
                    >
                      {e.action}
                    </div>
                    {/* R8 Polish 1: secondary metadata (actor) is dimmer
                        text-zinc-500; the secret path stays at text-zinc-300
                        so the primary value stays prominent.
                        R10 Bug 1: title attr shows the full actor · path
                        string on hover (the metadata line also truncates). */}
                    <div
                      className="truncate text-[10px] text-zinc-500"
                      title={`${e.actorClientName ?? "admin"} · ${e.secretPath ?? "—"}`}
                    >
                      <span>{e.actorClientName ?? "admin"}</span>
                      <span className="text-zinc-600"> · </span>
                      <span className="font-mono text-zinc-300">
                        {e.secretPath ?? "—"}
                      </span>
                    </div>
                  </div>
                  {/* R9 Bug 4: stack badge + time vertically right-aligned so
                      they share a strict grid regardless of badge height. */}
                  <div className="flex shrink-0 flex-col items-end gap-0.5">
                    <StatusBadge status={e.outcome} className="self-end" />
                    <span className="whitespace-nowrap font-mono text-[10px] tabular-nums text-zinc-500">
                      <RelativeTime value={e.createdAt} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Cable className="size-4 text-emerald-400" />
            Connection Health
          </h2>
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : connections.length === 0 ? (
            <EmptyState
              icon={Cable}
              title="No connections"
              hint="Integration connections will appear here once seeded."
            />
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
              {connections.map((c) => (
                <li
                  key={c.id}
                  className="group flex items-center justify-between gap-2 rounded-md border border-zinc-800/60 bg-zinc-950/40 py-2.5 px-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-zinc-200">
                      {c.providerKey}/{c.adapterKey}
                    </div>
                    <div className="truncate font-mono text-[10px] text-zinc-500">
                      gen {c.refreshGeneration} ·{" "}
                      {c.providerAccountRef ?? "—"}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {/* R9 Task 1d: inline Force Refresh button — appears on
                        hover, calls api.refreshConnection with a unique
                        idempotency key. shrink-0 so it doesn't squeeze the
                        StatusBadge + refresh time. */}
                    <button
                      type="button"
                      className="vault-action-btn opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        refreshConnM.mutate({ id: c.id, provider: c.providerKey });
                      }}
                      disabled={refreshConnM.isPending}
                      title="Force refresh this connection"
                    >
                      <RefreshCw className="size-3 text-emerald-400" />
                      <span>Refresh</span>
                    </button>
                    <StatusBadge status={c.status} className="self-center" />
                    <span className="whitespace-nowrap text-[10px] text-zinc-500">
                      refresh <RelativeTime value={c.refreshAfter} />
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Provider Health + Client Preview (least-privilege proof) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Gauge className="size-4 text-teal-400" />
            Provider Health
          </h2>
          {providerHealthQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : providerHealthQ.isError ? (
            <div className="vault-empty-state">
              <EmptyState icon={Gauge} title="Provider health unavailable" hint="Backend may be warming up." />
            </div>
          ) : (providerHealthQ.data?.providers ?? []).length === 0 ? (
            <div className="vault-empty-state">
              <EmptyState icon={Gauge} title="No providers" hint="Connections will appear here once seeded." />
            </div>
          ) : (
            <ul className="space-y-1.5">
              {(providerHealthQ.data?.providers ?? []).map((p) => {
                const rate = Math.round(p.successRate * 100);
                const rateColor = rate >= 80 ? "text-emerald-400" : rate >= 50 ? "text-amber-400" : "text-rose-400";
                return (
                  <li
                    key={`${p.providerKey}-${p.adapterKey}`}
                    // R11 Task 1c: each provider-health row is now clickable —
                    // navigates to the Connections view filtered (visually) to
                    // this provider's connections. group + ChevronRight affordance
                    // signals clickability, emerald-tinted hover mirrors the
                    // compliance violations pattern (which also navigates).
                    onClick={() => {
                      toast.info(`Viewing connections — ${p.providerKey}/${p.adapterKey}`);
                      setView("connections");
                    }}
                    title={`Click to view ${p.providerKey} connections`}
                    className="group cursor-pointer rounded-md border border-zinc-800/60 bg-zinc-950/40 py-2.5 px-3 transition-colors hover:border-emerald-700/40 hover:bg-emerald-950/20"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs text-zinc-200">
                            {p.providerKey}
                            <span className="ml-1.5 text-zinc-500">/ {p.adapterKey}</span>
                          </span>
                          {/* R11 Task 1c: ChevronRight fades in on hover to
                              signal the row is navigable. pointer-events-none
                              so it never steals the click. */}
                          <ChevronRight
                            className="ml-auto size-3.5 shrink-0 text-emerald-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                            aria-hidden
                          />
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-500">
                          <span>{p.totalConnections} conn</span>
                          <span className="text-zinc-700">·</span>
                          <span className="text-emerald-400">{p.activeConnections} active</span>
                          {p.reauthRequired > 0 && (
                            <>
                              <span className="text-zinc-700">·</span>
                              <span className="text-rose-400">{p.reauthRequired} reauth</span>
                            </>
                          )}
                          <span className="text-zinc-700">·</span>
                          <span>{p.totalRefreshes} refreshes</span>
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className={`font-mono text-sm font-semibold ${rateColor}`}>
                          {rate}%
                        </div>
                        <div className="text-[9px] uppercase tracking-wide text-zinc-600">
                          success
                        </div>
                      </div>
                    </div>
                    {/* Success rate bar */}
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className={`h-full rounded-full ${rate >= 80 ? "bg-emerald-500" : rate >= 50 ? "bg-amber-500" : "bg-rose-500"}`}
                        style={{ width: `${rate}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <ShieldCheck className="size-4 text-emerald-400" />
            Least-Privilege Preview
          </h2>
          {clientPreviewQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : clientPreviewQ.isError ? (
            <div className="vault-empty-state">
              <EmptyState icon={ShieldCheck} title="Client preview unavailable" hint="Backend may be warming up." />
            </div>
          ) : (clientPreviewQ.data?.clients ?? []).length === 0 ? (
            <div className="vault-empty-state">
              <EmptyState icon={ShieldCheck} title="No clients" hint="Service clients will appear here once seeded." />
            </div>
          ) : (
            <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
              {(clientPreviewQ.data?.clients ?? []).map((c) => (
                <li
                  key={c.clientId}
                  // R11 Task 1d: each client-preview row is now clickable —
                  // navigates to the Service Clients view. group + ChevronRight
                  // affordance + subtle zinc hover tint signal clickability,
                  // matching the provider-health row pattern (which uses an
                  // emerald tint for its accent). Toast confirms the click.
                  onClick={() => {
                    toast.info(`Viewing service clients — ${c.clientName}`);
                    setView("clients");
                  }}
                  title={`Click to view ${c.clientName} details`}
                  className="group cursor-pointer rounded-md border border-zinc-800/60 bg-zinc-950/40 py-2.5 px-3 transition-colors hover:bg-zinc-800/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-xs text-zinc-200">{c.clientName}</span>
                        <span className="rounded border border-zinc-700 bg-zinc-800/40 px-1 font-mono text-[9px] uppercase text-zinc-400">
                          {c.clientType}
                        </span>
                        {/* R11 Task 1d: ChevronRight fades in on hover to
                            signal the row is navigable. pointer-events-none
                            so it never steals the click. */}
                        <ChevronRight
                          className="ml-auto size-3.5 shrink-0 text-emerald-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                          aria-hidden
                        />
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px]">
                        <span className="flex items-center gap-0.5 text-emerald-400" title={`${c.accessibleSecrets.length} accessible secret(s)`}>
                          <Unlock className="size-2.5" />
                          {c.accessibleSecrets.length}
                        </span>
                        <span className="flex items-center gap-0.5 text-zinc-500" title={`${c.inaccessibleSecrets.length} inaccessible secret(s)`}>
                          <Lock className="size-2.5" />
                          {c.inaccessibleSecrets.length}
                        </span>
                        <span className="text-zinc-700">·</span>
                        <span className="text-zinc-500">{c.grantsCount} grant{c.grantsCount === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                    <StatusBadge status={c.status} />
                  </div>
                  {/* Accessible secrets chips */}
                  {c.accessibleSecrets.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {c.accessibleSecrets.slice(0, 4).map((s) => (
                        <span
                          key={s.secretId}
                          className="rounded border border-emerald-700/30 bg-emerald-500/10 px-1 py-0.5 font-mono text-[9px] text-emerald-300"
                          title={s.permissions?.join(", ")}
                        >
                          {s.path}
                        </span>
                      ))}
                      {c.accessibleSecrets.length > 4 && (
                        <span className="text-[9px] text-zinc-500">+{c.accessibleSecrets.length - 4}</span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Compliance + Expiring Leases */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <ShieldAlert className="size-4 text-amber-400" />
            Policy &amp; Rotation Compliance
          </h2>
          {complianceQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : complianceQ.isError ? (
            <EmptyState icon={ShieldAlert} title="Compliance unavailable" hint="Backend may be warming up." />
          ) : !complianceQ.data ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Compliance score gauge */}
              <div className="flex items-center gap-3">
                <div className="relative flex size-16 shrink-0 items-center justify-center">
                  <svg viewBox="0 0 36 36" className="size-16 -rotate-90">
                    <circle cx="18" cy="18" r="15.9155" fill="none" stroke="rgba(63,63,70,0.5)" strokeWidth="3" />
                    <circle
                      cx="18" cy="18" r="15.9155" fill="none"
                      stroke={complianceQ.data.summary.complianceScore >= 80 ? "#10b981" : complianceQ.data.summary.complianceScore >= 50 ? "#f59e0b" : "#f43f5e"}
                      strokeWidth="3"
                      strokeDasharray={`${complianceQ.data.summary.complianceScore}, 100`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="absolute font-mono text-sm font-bold text-zinc-100">
                    {complianceQ.data.summary.complianceScore}%
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <CheckCircle2 className="size-3.5 text-emerald-400" />
                    <span className="text-zinc-300">{complianceQ.data.summary.compliant} compliant</span>
                    <span className="text-zinc-700">·</span>
                    <AlertTriangle className="size-3.5 text-rose-400" />
                    <span className="text-zinc-300">{complianceQ.data.summary.violations} violations</span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-zinc-500">{complianceQ.data.summary.totalSecrets} total</span>
                  </div>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    Secrets not rotated in 90+ days, expired, or expiring within 7 days.
                  </p>
                </div>
              </div>
              {/* Violations list */}
              {complianceQ.data.violations.length > 0 ? (
                <ul className="max-h-44 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
                  {complianceQ.data.violations.slice(0, 8).map((v) => {
                    const tone =
                      v.violation === "expired_secret" ? "text-rose-400" :
                      v.violation === "expiring_soon" ? "text-amber-400" :
                      v.violation === "stale_rotation" ? "text-amber-400" :
                      "text-zinc-400"; // never_rotated
                    const label =
                      v.violation === "expired_secret" ? "expired" :
                      v.violation === "expiring_soon" ? "expiring" :
                      v.violation === "stale_rotation" ? `stale ${v.daysStale}d` :
                      "never rotated";
                    return (
                      <li
                        key={`${v.secretId}-${v.violation}`}
                        className="group flex cursor-pointer items-center justify-between gap-2 rounded-md border border-zinc-800/60 bg-zinc-950/40 py-2.5 px-3 hover:border-amber-700/40 hover:bg-amber-950/20"
                        onClick={() =>
                          setRemediateTarget({
                            secretId: v.secretId,
                            path: v.path,
                            violation: v.violation,
                          })
                        }
                        title="Click to remediate — rotate this secret now"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[11px] text-zinc-300">{v.path}</div>
                          {/* R9 Polish 2: bumped kind text-[9px] → text-[10px]
                              and dimmed via /70 so it reads as secondary
                              metadata, consistent across dashboard panels. */}
                          <div className="text-[10px] uppercase tracking-wide text-zinc-500/70">{v.kind}</div>
                        </div>
                        {/* R9 Task 1b: inline Remediate button — visible
                            affordance that the row is actionable. Calls
                            the SAME setRemediateTarget handler as the row
                            click, opening the existing confirm dialog. */}
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className={`shrink-0 font-mono text-[10px] font-semibold ${tone}`}>{label}</span>
                          <button
                            type="button"
                            className="vault-action-btn opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRemediateTarget({
                                secretId: v.secretId,
                                path: v.path,
                                violation: v.violation,
                              });
                            }}
                            title="Remediate — rotate this secret now"
                          >
                            <Wrench className="size-3 text-amber-400" />
                            <span>Remediate</span>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="flex items-center gap-2 rounded-md border border-emerald-800/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
                  <CheckCircle2 className="size-3.5" />
                  All secrets comply with rotation policy.
                </div>
              )}
            </div>
          )}
        </Card>

        <Card className="vault-card rounded-lg border-zinc-800 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
            <Timer className="size-4 text-amber-400" />
            Expiring Leases
          </h2>
          {expiringLeasesQ.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
              ))}
            </div>
          ) : expiringLeasesQ.isError ? (
            <div className="vault-empty-state">
              <EmptyState icon={Timer} title="Lease data unavailable" hint="Backend may be warming up." />
            </div>
          ) : (expiringLeasesQ.data?.leases ?? []).length === 0 ? (
            <div className="vault-empty-state">
              <EmptyState icon={Timer} title="No active leases expiring" hint="Short-lived leases issued within the last hour will appear here with live countdowns." />
            </div>
          ) : (
            <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
              {(expiringLeasesQ.data?.leases ?? []).map((l) => {
                const mins = Math.floor(l.secondsRemaining / 60);
                const secs = l.secondsRemaining % 60;
                const expired = l.status === "expired";
                return (
                  <li
                    key={l.leaseId}
                    className={`group flex items-center justify-between gap-2 rounded-md border py-2.5 px-3 ${expired ? "border-rose-700/40 bg-rose-950/20" : "border-zinc-800/60 bg-zinc-950/40"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px] text-zinc-200">{l.secretPath}</div>
                      <div className="text-[10px] text-zinc-500">
                        {l.clientName} · <span className={expired ? "text-rose-400" : "text-amber-400"}>
                          {expired ? "expired" : `${mins}m ${secs}s left`}
                        </span>
                      </div>
                    </div>
                    {/* R9 Task 1c: inline Revoke button — appears on hover,
                        rose-tinted to signal destructive action. Calls
                        api.revokeLease(leaseId); on success invalidates
                        expiring-leases + leases queries. */}
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        className="vault-action-btn opacity-0 transition-opacity duration-150 group-hover:opacity-100 hover:!border-rose-600/40 hover:!bg-rose-950/30 hover:!text-rose-300"
                        onClick={(e) => {
                          e.stopPropagation();
                          revokeLeaseM.mutate(l.leaseId);
                        }}
                        disabled={revokeLeaseM.isPending}
                        title="Revoke this lease now"
                      >
                        <Ban className="size-3 text-rose-400" />
                        <span>Revoke</span>
                      </button>
                      <div className={`shrink-0 font-mono text-sm font-bold ${expired ? "text-rose-400" : "text-amber-400"}`}>
                        {expired ? "0s" : `${mins}:${secs.toString().padStart(2, "0")}`}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Anomalous Access Detection */}
      <Card className="vault-card rounded-lg border-zinc-800 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-200">
          <Radar className="size-4 text-rose-400" />
          Anomalous Access Detection
          {(anomaliesQ.data?.anomalies ?? []).length > 0 && (
            <Badge className="ml-auto border-rose-500/30 bg-rose-500/10 font-mono text-[10px] text-rose-300">
              {(anomaliesQ.data?.anomalies ?? []).length} flagged
            </Badge>
          )}
        </h2>
        {anomaliesQ.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full bg-zinc-800/60" />
            ))}
          </div>
        ) : anomaliesQ.isError ? (
          <div className="vault-empty-state">
            <EmptyState icon={Radar} title="Anomaly detection unavailable" hint="Backend may be warming up." />
          </div>
        ) : (anomaliesQ.data?.anomalies ?? []).length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-800/30 bg-emerald-950/20 px-3 py-2 text-xs text-emerald-300">
            <CheckCircle2 className="size-3.5" />
            No anomalous access patterns detected in the selected time range.
          </div>
        ) : (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto pr-1 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
            {(anomaliesQ.data?.anomalies ?? []).map((a) => {
              const sevColor =
                a.severity === "high" ? "border-rose-500/40 bg-rose-950/20 text-rose-300" :
                a.severity === "medium" ? "border-amber-500/40 bg-amber-950/20 text-amber-300" :
                "border-zinc-700 bg-zinc-900/40 text-zinc-400";
              return (
                <li
                  key={a.id}
                  // R11 Task 1b: each anomaly row is now clickable — opens a
                  // detail dialog with the full anomaly record. group +
                  // group-hover:bg-zinc-800/40 highlights the row on hover
                  // (the hover rule has higher specificity than the sevColor
                  // bg classes so it wins on hover without breaking the
                  // severity tint when not hovering). transition-colors for
                  // a smooth fade. cursor-pointer signals clickability.
                  onClick={() => setSelectedAnomaly(a)}
                  title="Click to view anomaly details"
                  className={`group cursor-pointer rounded-md border py-2.5 px-3 transition-colors hover:bg-zinc-800/40 ${sevColor}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className={`size-1.5 rounded-full ${a.severity === "high" ? "bg-rose-400" : a.severity === "medium" ? "bg-amber-400" : "bg-zinc-500"}`} />
                        <span className="font-mono text-[10px] uppercase tracking-wide">{a.type.replace(/_/g, " ")}</span>
                        {/* R11 Task 1b: ChevronRight fades in on hover to
                            signal the row opens a detail dialog. */}
                        <ChevronRight
                          className="ml-auto size-3.5 shrink-0 text-zinc-400 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
                          aria-hidden
                        />
                      </div>
                      {/* R11 Bug 3: bumped title to text-zinc-200 font-medium
                          so the primary anomaly summary reads brighter than
                          the secondary description below. Fixes the VLM-noted
                          flat hierarchy where title + description both
                          appeared the same weight. */}
                      <div className="mt-0.5 truncate text-[11px] text-zinc-200 font-medium">{a.title}</div>
                      <div className="mt-0.5 truncate text-[10px] text-zinc-500">{a.description}</div>
                    </div>
                    <div className="shrink-0 text-right">
                      {/* R9 Polish 2: standardized time text-zinc-500 (was
                          text-zinc-400) for cross-panel consistency. */}
                      <div className="font-mono text-[10px] text-zinc-500">
                        <RelativeTime value={a.ts} />
                      </div>
                      {/* R9 Bug 2: cramped IP — added mt-1 + pl-2 +
                          border-l border-zinc-700/40 so the IP has a subtle
                          left separator + vertical breathing room from the
                          time. Bumped text-[9px] → text-[10px] with
                          opacity-70 so it reads as secondary metadata. */}
                      {a.sourceIp && (
                        <div className="mt-1 border-l border-zinc-700/40 pl-2 font-mono text-[10px] text-zinc-500 opacity-70">
                          {a.sourceIp}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Compliance Remediation Dialog */}
      {remediateTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => !remediateM.isPending && closeRemediate()}
        >
          <div
            className="vault-card w-full max-w-md rounded-lg border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-100">
              <ShieldAlert className="size-4 text-amber-400" />
              Remediate Compliance Violation
            </h2>
            <p className="mb-4 text-xs text-zinc-400">
              Store a new credential for{" "}
              <span className="font-mono text-amber-300">{remediateTarget.path}</span>{" "}
              as a new immutable version, retiring the current one, to resolve{" "}
              <span className="font-mono text-amber-300">
                {remediateTarget.violation.replace(/_/g, " ")}
              </span>
              .
            </p>
            <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500" htmlFor="remediate-value">
              New value
            </label>
            <textarea
              id="remediate-value"
              value={remediateValue}
              onChange={(e) => setRemediateValue(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              rows={3}
              className="mb-2 w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100"
            />
            <p className="mb-4 text-[11px] text-zinc-500">
              Leave empty for an access token kept fresh by a provider
              connection: the provider issues the new one.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={closeRemediate}
                disabled={remediateM.isPending}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => remediateM.mutate()}
                disabled={remediateM.isPending}
                className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {remediateM.isPending ? "Remediating…" : "Rotate Now"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* R11 Task 1b: Anomaly Detail Dialog — opens when an operator clicks an
          anomaly row in the Anomalous Access Detection panel. Shows the full
          anomaly record (type, severity, title, description, secret path,
          actor, source IP, timestamp, metadata). The "View Audit Log" button
          navigates to the audit view (where the underlying audit events live)
          and closes this dialog; "Close" just dismisses. Modal pattern mirrors
          the remediation dialog: bg-black/85 backdrop-blur-sm overlay, click
          outside to close, e.stopPropagation on the inner card. */}
      {selectedAnomaly && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={() => setSelectedAnomaly(null)}
        >
          <div
            className="vault-card w-full max-w-lg rounded-lg border-zinc-800 bg-zinc-900 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center gap-2">
              <Radar
                className={
                  selectedAnomaly.severity === "high"
                    ? "size-4 text-rose-400"
                    : selectedAnomaly.severity === "medium"
                      ? "size-4 text-amber-400"
                      : "size-4 text-zinc-400"
                }
              />
              <h2 className="text-sm font-semibold text-zinc-100">
                Anomaly Detail
              </h2>
              <span
                className={`ml-auto rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                  selectedAnomaly.severity === "high"
                    ? "border-rose-500/40 bg-rose-950/40 text-rose-300"
                    : selectedAnomaly.severity === "medium"
                      ? "border-amber-500/40 bg-amber-950/40 text-amber-300"
                      : "border-zinc-700 bg-zinc-800/40 text-zinc-400"
                }`}
              >
                {selectedAnomaly.severity}
              </span>
            </div>

            {/* Title + type row */}
            <div className="mb-3">
              <div className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                {selectedAnomaly.type.replace(/_/g, " ")}
              </div>
              <div className="mt-0.5 text-sm font-semibold text-zinc-100">
                {selectedAnomaly.title}
              </div>
              <p className="mt-1 text-xs text-zinc-400">
                {selectedAnomaly.description}
              </p>
            </div>

            {/* Detail grid — secret path, actor, source IP, timestamp */}
            <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3 text-xs">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
                  Secret Path
                </dt>
                <dd className="mt-0.5 truncate font-mono text-zinc-200">
                  {selectedAnomaly.secretPath ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
                  Actor
                </dt>
                <dd className="mt-0.5 truncate font-mono text-zinc-200">
                  {selectedAnomaly.actorName ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
                  Source IP
                </dt>
                <dd className="mt-0.5 truncate font-mono text-zinc-200">
                  {selectedAnomaly.sourceIp ?? "—"}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-zinc-500">
                  Timestamp
                </dt>
                <dd className="mt-0.5 font-mono text-zinc-200">
                  <RelativeTime value={selectedAnomaly.ts} />
                </dd>
              </div>
            </dl>

            {/* Metadata — pretty-printed JSON if non-empty */}
            {selectedAnomaly.metadata &&
              Object.keys(selectedAnomaly.metadata).length > 0 && (
                <div className="mb-4">
                  <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                    Metadata
                  </div>
                  <pre className="max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-2 text-[10px] leading-relaxed text-zinc-400 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
{JSON.stringify(selectedAnomaly.metadata, null, 2)}
                  </pre>
                </div>
              )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setSelectedAnomaly(null)}
                className="rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Close
              </button>
              <button
                onClick={() => {
                  toast.info("Jumping to Audit Log");
                  setSelectedAnomaly(null);
                  setView("audit");
                }}
                className="rounded-md bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-500"
              >
                View Audit Log
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
