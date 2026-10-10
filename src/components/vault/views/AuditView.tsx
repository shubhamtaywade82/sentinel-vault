"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Download,
  Loader2,
  ScrollText,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { api } from "@/lib/vault/client";
import type { AuditEventListItem } from "@/lib/vault/types";
import { StatusBadge, statusTone, type StatusTone } from "../StatusBadge";
import { AbsoluteTime, RelativeTime } from "../RelativeTime";
import { CopyButton } from "../CopyButton";
import { EmptyState, ForbiddenState, isApiWarmingError, isForbidden } from "../Status";
import { useVaultStore } from "../store";
import { cn } from "@/lib/utils";

const ACTION_TONE: Record<string, StatusTone> = {
  "secret.": "emerald",
  "secret.reveal": "emerald",
  "secret.rotate": "amber",
  "secret.revoke": "rose",
  "secret.version": "teal",
  "refresh.": "teal",
  "refresh.run": "teal",
  "refresh.succeeded": "emerald",
  "refresh.failed": "rose",
  "refresh.transient": "amber",
  "connection.": "teal",
  "connection.credential": "emerald",
  "client.": "zinc",
  "grant.": "amber",
};

function actionTone(action: string): StatusTone {
  for (const key of Object.keys(ACTION_TONE)) {
    if (action.startsWith(key)) return ACTION_TONE[key];
  }
  return "zinc";
}

export function AuditView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);

  const [actionPrefix, setActionPrefix] = useState("");
  const [outcome, setOutcome] = useState<string>("all");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const limit = 100;

  // Reset pagination when filters change.
  function resetFilters() {
    setOffset(0);
    setPage(0);
  }

  const auditQ = useQuery({
    queryKey: ["audit", workspaceId, refreshTick, actionPrefix, outcome, page],
    queryFn: () =>
      api.listAudit({
        workspaceId: workspaceId || undefined,
        action: actionPrefix || undefined,
        outcome: outcome === "all" ? undefined : outcome,
        limit,
        offset: page * limit,
      }),
  });

  const warming = auditQ.isError && isApiWarmingError(auditQ.error);
  const forbidden = auditQ.isError && isForbidden(auditQ.error);
  const events = auditQ.data?.events ?? [];
  const hasMore = events.length === limit;

  async function onExportCsv() {
    setExporting(true);
    try {
      const blob = await api.exportAuditCsv({
        workspaceId: workspaceId || undefined,
        action: actionPrefix || undefined,
        outcome: outcome === "all" ? undefined : outcome,
        limit: 10000,
      });
      // Try to count rows from the blob text so the toast can report it.
      let count: number | undefined;
      try {
        const text = await blob.text();
        const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
        // Subtract the header row.
        count = Math.max(lines.length - 1, 0);
      } catch {
        // ignore — we just won't report the count.
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ts = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .replace("Z", "");
      a.download = `vault-audit-events-${ts}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast.success(
        count != null ? `Exported ${count} events` : "Exported audit log",
        {
          description: `vault-audit-events-${ts}.csv`,
        },
      );
    } catch (e) {
      const err = e as { code?: string; status?: number; message?: string };
      if (err.code === "admin_required" || err.status === 403) {
        toast.error("Export requires admin — exit client view first");
      } else {
        toast.error(`Export failed: ${err.message ?? "unknown error"}`);
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="vault-enter space-y-4"
    >
      <div
        role="note"
        className="flex items-center gap-2 rounded-md border border-emerald-700/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
      >
        <ScrollText className="size-3.5 shrink-0 text-emerald-400" />
        No secret values are stored in this audit log. Records are append-only
        and contain metadata only.
      </div>

      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — audit events may be empty.
        </div>
      )}

      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Audit Log</h1>
        <p className="text-xs text-zinc-500">
          Value-free, append-only access trail.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Filter by action prefix (e.g. secret.reveal)"
          value={actionPrefix}
          onChange={(e) => {
            setActionPrefix(e.target.value);
            resetFilters();
          }}
          className="h-9 max-w-xs border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200 placeholder:text-zinc-600 font-mono"
          aria-label="Filter by action prefix"
        />
        <Select
          value={outcome}
          onValueChange={(v) => {
            setOutcome(v);
            resetFilters();
          }}
        >
          <SelectTrigger
            className="h-9 w-[150px] min-h-9 border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200"
            aria-label="Filter by outcome"
          >
            <SelectValue placeholder="Outcome" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
            <SelectItem value="all">All outcomes</SelectItem>
            <SelectItem value="success" className="font-mono">
              success
            </SelectItem>
            <SelectItem value="denied" className="font-mono">
              denied
            </SelectItem>
            <SelectItem value="error" className="font-mono">
              error
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          onClick={onExportCsv}
          disabled={exporting}
          className="min-h-9 border-emerald-800/50 bg-emerald-950/30 text-emerald-100 hover:bg-emerald-950/50 hover:text-emerald-50"
          aria-label="Export audit log as CSV"
          title="Export the current filter as a CSV file (max 10,000 rows)"
        >
          {exporting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5 text-emerald-400" />
          )}
          <span className="hidden sm:inline">Export CSV</span>
        </Button>
        <div className="ml-auto text-xs text-zinc-500">
          {page * limit + events.length} shown
        </div>
      </div>

      {forbidden ? (
        <ForbiddenState />
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
          <div className="max-h-[70vh] overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700 [&::-webkit-scrollbar-track]:bg-transparent">
            <Table className="vault-table">
              <TableHeader className="sticky top-0 z-10 bg-zinc-950/95 backdrop-blur">
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="text-zinc-400">Time</TableHead>
                  <TableHead className="text-zinc-400">Actor</TableHead>
                  <TableHead className="text-zinc-400">Action</TableHead>
                  <TableHead className="text-zinc-400">Resource</TableHead>
                  <TableHead className="text-zinc-400">Outcome</TableHead>
                  <TableHead className="text-zinc-400">Reason</TableHead>
                  <TableHead className="text-zinc-400">Request ID</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {auditQ.isLoading ? (
                  Array.from({ length: 8 }).map((_, i) => (
                    <TableRow key={i} className="border-zinc-800">
                      <TableCell colSpan={7}>
                        <Skeleton className="h-7 w-full bg-zinc-800/60" />
                      </TableCell>
                    </TableRow>
                  ))
                ) : events.length === 0 ? (
                  <TableRow className="border-zinc-800">
                    <TableCell colSpan={7}>
                      <EmptyState
                        icon={ScrollText}
                        title="No audit events"
                        hint="Trigger a reveal or refresh to populate the audit log."
                      />
                    </TableCell>
                  </TableRow>
                ) : (
                  events.map((e) => <AuditRow key={e.id} event={e} />)
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={page === 0 || forbidden}
          onClick={() => setPage((p) => Math.max(0, p - 1))}
          className="border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800"
        >
          <ChevronUp className="size-3.5" />
          Prev
        </Button>
        <span className="text-xs text-zinc-500">Page {page + 1}</span>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasMore || forbidden}
          onClick={() => setPage((p) => p + 1)}
          className="border-zinc-800 bg-zinc-900/60 text-zinc-200 hover:bg-zinc-800"
        >
          Load more
          <ChevronDown className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function AuditRow({ event }: { event: AuditEventListItem }) {
  const actor = event.actorClientName ?? "system";
  const isSystem = !event.actorClientId && !event.actorClientName;
  const tone = actionTone(event.action);
  const toneClasses: Record<StatusTone, string> = {
    emerald: "border-emerald-700/40 bg-emerald-500/10 text-emerald-300",
    amber: "border-amber-700/40 bg-amber-500/10 text-amber-300",
    rose: "border-rose-700/40 bg-rose-500/10 text-rose-300",
    zinc: "border-zinc-700/60 bg-zinc-500/10 text-zinc-300",
    teal: "border-teal-700/40 bg-teal-500/10 text-teal-300",
    sky: "border-sky-700/40 bg-sky-500/10 text-sky-300",
    violet: "border-violet-700/40 bg-violet-500/10 text-violet-300",
  };
  return (
    <TableRow
      className={cn(
        "border-zinc-800 hover:bg-zinc-800/40",
        "[&>td:first-child]:sticky [&>td:first-child]:left-0 [&>td:first-child]:bg-zinc-950/95 [&>td:first-child]:z-10",
      )}
    >
      <TableCell className="text-xs">
        <span className="font-mono text-zinc-300">
          <AbsoluteTime value={event.createdAt} />
        </span>
        <div className="text-[10px] text-zinc-600">
          <RelativeTime value={event.createdAt} />
        </div>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn(
            "border font-mono text-[10px]",
            isSystem
              ? "border-zinc-700 bg-zinc-800/40 text-zinc-400"
              : "border-zinc-700 bg-zinc-800/40 text-zinc-200",
          )}
        >
          {actor}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge
          variant="outline"
          className={cn(
            "border font-mono text-[10px]",
            toneClasses[tone],
          )}
        >
          {event.action}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-[11px] text-zinc-300">
        {event.secretPath ?? event.vaultSecretId ?? "—"}
      </TableCell>
      <TableCell>
        <StatusBadge status={event.outcome} />
      </TableCell>
      <TableCell className="font-mono text-[11px]">
        {event.reasonCode ? (
          <span className="text-amber-300">{event.reasonCode}</span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-zinc-500">
            {event.requestId ? `${event.requestId.slice(0, 8)}…` : "—"}
          </span>
          {event.requestId && (
            <CopyButton
              text={event.requestId}
              toastLabel="Request ID copied"
              size="icon"
              variant="ghost"
            />
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}
