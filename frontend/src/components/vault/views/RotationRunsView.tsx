"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { Skeleton } from "@/components/ui/skeleton";
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
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

import { api } from "@/lib/vault/client";
import type { RotationRunRow } from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge } from "../StatusBadge";
import { RelativeTime, AbsoluteTime } from "../RelativeTime";
import { CopyButton } from "../CopyButton";
import { EmptyState, ForbiddenState, isApiWarmingError, isForbidden } from "../Status";
import { cn } from "@/lib/utils";

const STATUSES = [
  "all",
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
];

export function RotationRunsView() {
  const refreshTick = useVaultStore((s) => s.refreshTick);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const runsQ = useQuery({
    queryKey: ["runs", refreshTick, statusFilter],
    queryFn: () =>
      api.listRuns({
        limit: 100,
        status: statusFilter === "all" ? undefined : statusFilter,
      }),
  });

  const runDetailQ = useQuery({
    queryKey: ["run", selectedId],
    queryFn: () => api.getRun(selectedId!),
    enabled: !!selectedId,
  });

  const warming = runsQ.isError && isApiWarmingError(runsQ.error);
  const forbidden = runsQ.isError && isForbidden(runsQ.error);
  const runs = runsQ.data?.runs ?? [];

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — rotation runs list may be empty.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Rotation Runs</h1>
          <p className="text-xs text-zinc-500">
            Durable, idempotent rotation runs with lease-based concurrency and
            generation guards.
          </p>
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            className="h-9 w-[160px] min-h-9 border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200"
            aria-label="Filter by status"
          >
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="font-mono">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {forbidden ? (
        <ForbiddenState />
      ) : (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <Table className="vault-table">
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-zinc-400">Operation</TableHead>
              <TableHead className="text-zinc-400">Ref</TableHead>
              <TableHead className="text-zinc-400">Status</TableHead>
              <TableHead className="text-zinc-400 text-right">Attempts</TableHead>
              <TableHead className="text-zinc-400">Run After</TableHead>
              <TableHead className="text-zinc-400">Started</TableHead>
              <TableHead className="text-zinc-400">Completed</TableHead>
              <TableHead className="text-zinc-400">Error</TableHead>
              <TableHead className="text-zinc-400">Correlation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runsQ.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i} className="border-zinc-800">
                  <TableCell colSpan={9}>
                    <Skeleton className="h-7 w-full bg-zinc-800/60" />
                  </TableCell>
                </TableRow>
              ))
            ) : runs.length === 0 ? (
              <TableRow className="border-zinc-800">
                <TableCell colSpan={9}>
                  <EmptyState
                    icon={RefreshCw}
                    title="No rotation runs"
                    hint="Trigger a refresh from the Connections view, or wait for the watchdog to wake a connection."
                  />
                </TableCell>
              </TableRow>
            ) : (
              runs.map((r) => (
                <RunRow
                  key={r.id}
                  run={r}
                  onClick={() => setSelectedId(r.id)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      )}

      <Sheet
        open={!!selectedId}
        onOpenChange={(o) => !o && setSelectedId(null)}
      >
        <SheetContent
          side="right"
          className="border-l border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-md"
        >
          <SheetHeader className="border-b border-zinc-800">
            <SheetTitle className="font-mono text-sm text-zinc-200">
              {runDetailQ.data?.run?.operation ?? "Rotation run"}
            </SheetTitle>
            <SheetDescription className="text-xs text-zinc-500">
              Full run detail and lifecycle timeline.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {runDetailQ.isLoading || !runDetailQ.data ? (
              <Skeleton className="h-40 w-full bg-zinc-800" />
            ) : (
              <RunDetail run={runDetailQ.data.run} />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RunRow({
  run,
  onClick,
}: {
  run: RotationRunRow;
  onClick: () => void;
}) {
  const ref = run.connectionId ?? run.vaultSecretId ?? "—";
  return (
    <TableRow
      onClick={onClick}
      className={cn(
        "cursor-pointer border-zinc-800 hover:bg-zinc-800/40",
        "[&>td:first-child]:sticky [&>td:first-child]:left-0 [&>td:first-child]:bg-zinc-950/95 [&>td:first-child]:z-10",
      )}
    >
      <TableCell>
        <Badge
          variant="outline"
          className="border-zinc-700 bg-zinc-800/40 font-mono text-[10px] text-zinc-200"
        >
          {run.operation}
        </Badge>
      </TableCell>
      <TableCell className="font-mono text-[11px] text-zinc-400">
        {ref.slice(0, 10)}…
      </TableCell>
      <TableCell>
        <StatusBadge status={run.status} />
      </TableCell>
      <TableCell className="text-right font-mono text-xs tabular-nums text-zinc-300">
        {run.attemptCount}
      </TableCell>
      <TableCell className="text-xs text-zinc-400">
        <RelativeTime value={run.runAfter} />
      </TableCell>
      <TableCell className="text-xs text-zinc-400">
        <RelativeTime value={run.startedAt} fallback="—" />
      </TableCell>
      <TableCell className="text-xs text-zinc-400">
        <RelativeTime value={run.completedAt} fallback="—" />
      </TableCell>
      <TableCell className="font-mono text-[11px]">
        {run.errorCode ? (
          <span className="text-rose-300">{run.errorCode}</span>
        ) : (
          <span className="text-zinc-600">—</span>
        )}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[10px] text-zinc-500">
            {run.correlationId ? `${run.correlationId.slice(0, 8)}…` : "—"}
          </span>
          {run.correlationId && (
            <CopyButton
              text={run.correlationId}
              toastLabel="Correlation ID copied"
              size="icon"
              variant="ghost"
            />
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

function RunDetail({ run }: { run: RotationRunRow }) {
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
        <Detail label="Status" value={<StatusBadge status={run.status} />} />
        <Detail label="Operation" value={run.operation} mono />
        <Detail label="Attempts" value={run.attemptCount} mono />
        <Detail label="Result Version" value={run.resultVersionId ?? "—"} mono />
        <Detail label="Error Code" value={run.errorCode ?? "—"} mono />
        <Detail
          label="Lease Expires"
          value={<RelativeTime value={run.leaseExpiresAt} fallback="—" />}
        />
        <Detail
          label="Connection"
          value={run.connectionId ?? "—"}
          mono
        />
        <Detail label="Secret" value={run.vaultSecretId ?? "—"} mono />
      </div>

      <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Lifecycle
      </h3>
      <ol className="relative ml-3 border-l border-zinc-800 pl-4 text-xs">
        <TimelineItem
          label="Created"
          value={<AbsoluteTime value={run.createdAt} />}
        />
        <TimelineItem
          label="Run After"
          value={<AbsoluteTime value={run.runAfter} />}
        />
        {run.startedAt && (
          <TimelineItem
            label="Started"
            value={<AbsoluteTime value={run.startedAt} />}
          />
        )}
        {run.completedAt && (
          <TimelineItem
            label="Completed"
            value={<AbsoluteTime value={run.completedAt} />}
          />
        )}
      </ol>

      {run.correlationId && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wide text-zinc-600">
            Correlation ID
          </div>
          <div className="flex items-center gap-1">
            <span className="font-mono text-[11px] text-zinc-300">
              {run.correlationId}
            </span>
            <CopyButton
              text={run.correlationId}
              toastLabel="Correlation ID copied"
            />
          </div>
        </div>
      )}

      {run.idempotencyKey && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wide text-zinc-600">
            Idempotency Key
          </div>
          <span className="font-mono text-[11px] text-zinc-300">
            {run.idempotencyKey}
          </span>
        </div>
      )}
    </>
  );
}

function Detail({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-zinc-600">
        {label}
      </span>
      <span
        className={cn(
          "text-zinc-200",
          mono && "font-mono text-[11px] tabular-nums",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function TimelineItem({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <li className="relative mb-3">
      <span
        className="absolute -left-[21px] top-1 size-2 rounded-full bg-emerald-500"
        aria-hidden
      />
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className="font-mono text-[11px] text-zinc-300">{value}</div>
    </li>
  );
}
