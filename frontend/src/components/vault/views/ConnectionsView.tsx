"use client";

import { useMemo, useState } from "react";
import {
  Cable,
  KeyRound,
  LifeBuoy,
  MoreHorizontal,
  RefreshCw,
  ShieldOff,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { api } from "@/lib/vault/client";
import type { ConnectionListItem, CredentialResponse } from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge } from "../StatusBadge";
import { RelativeTime, AbsoluteTime } from "../RelativeTime";
import { CopyButton } from "../CopyButton";
import { ConfirmDialog } from "../ConfirmDialog";
import { SecretValueReveal } from "../SecretValueReveal";
import { EmptyState, isApiWarmingError } from "../Status";
import { cn } from "@/lib/utils";

export function ConnectionsView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [credTarget, setCredTarget] = useState<ConnectionListItem | null>(null);
  const [credResult, setCredResult] = useState<CredentialResponse | null>(null);
  const [credOpen, setCredOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ConnectionListItem | null>(null);
  const [recoverTarget, setRecoverTarget] = useState<ConnectionListItem | null>(null);
  const [recoverToken, setRecoverToken] = useState("");

  const connectionsQ = useQuery({
    queryKey: ["connections", workspaceId, refreshTick],
    queryFn: () => api.listConnections(workspaceId),
    enabled: !!workspaceId,
  });

  const warming = connectionsQ.isError && isApiWarmingError(connectionsQ.error);
  const connections = connectionsQ.data?.connections ?? [];
  const selected = useMemo(
    () => connections.find((c) => c.id === selectedId) ?? null,
    [connections, selectedId],
  );

  const refreshM = useMutation({
    mutationFn: (id: string) => api.refreshConnection(id),
    onSuccess: (res) => {
      toast.success(
        `Refresh ${res.rotationRun.status} — operation ${res.rotationRun.operation}`,
      );
      qc.invalidateQueries({ queryKey: ["connections", workspaceId] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e) => toast.error(`Refresh failed: ${(e as Error).message}`),
  });
  const credM = useMutation({
    mutationFn: (id: string) => api.connectionCredential(id, "access_token"),
    onSuccess: (res) => {
      setCredResult(res);
      setCredOpen(true);
    },
    onError: (e) => toast.error(`Get credential failed: ${(e as Error).message}`),
  });
  const reauthM = useMutation({
    mutationFn: (id: string) => api.reauthorizeConnection(id),
    onSuccess: (res) => {
      toast.success(`Reauthorize queued — ${res.rotationRun.status}`);
      qc.invalidateQueries({ queryKey: ["connections", workspaceId] });
    },
    onError: (e) => toast.error(`Reauthorize failed: ${(e as Error).message}`),
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => api.revokeConnection(id),
    onSuccess: () => {
      toast.success("Connection revoked");
      setRevokeTarget(null);
      qc.invalidateQueries({ queryKey: ["connections", workspaceId] });
    },
    onError: (e) => toast.error(`Revoke failed: ${(e as Error).message}`),
  });
  // Dhan issues no refresh tokens; its recovery material is a new access token.
  const recoverUsesAccessToken = recoverTarget?.adapterKey === "dhan_v1";
  const recoverM = useMutation({
    mutationFn: (input: { id: string; token?: string; isAccessToken: boolean }) =>
      api.recoverConnection(
        input.id,
        input.isAccessToken ? { newAccessToken: input.token } : { newRefreshToken: input.token },
      ),
    onSuccess: () => {
      toast.success("Connection recovered", {
        description: "Re-armed to active; watchdog will pick up the refresh cycle.",
      });
      setRecoverTarget(null);
      setRecoverToken("");
      qc.invalidateQueries({ queryKey: ["connections", workspaceId] });
      qc.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e) => toast.error(`Recover failed: ${(e as Error).message}`),
  });

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — connections list may be empty.
        </div>
      )}

      <div>
        <h1 className="text-lg font-semibold text-zinc-100">Connections</h1>
        <p className="text-xs text-zinc-500">
          Integration connections with proactive + request-time credential
          refresh. Bound secrets rotate via durable rotation runs.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <Table className="vault-table">
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-zinc-400">Provider</TableHead>
              <TableHead className="text-zinc-400">Adapter</TableHead>
              <TableHead className="text-zinc-400">Account</TableHead>
              <TableHead className="text-zinc-400">Status</TableHead>
              <TableHead className="text-zinc-400">Access Expires</TableHead>
              <TableHead className="text-zinc-400">Refresh After</TableHead>
              <TableHead className="text-zinc-400">Gen</TableHead>
              <TableHead className="text-zinc-400">Last Error</TableHead>
              <TableHead className="w-10 text-zinc-400" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {connectionsQ.isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i} className="border-zinc-800">
                  <TableCell colSpan={9}>
                    <Skeleton className="h-7 w-full bg-zinc-800/60" />
                  </TableCell>
                </TableRow>
              ))
            ) : connections.length === 0 ? (
              <TableRow className="border-zinc-800">
                <TableCell colSpan={9}>
                  <EmptyState
                    icon={Cable}
                    title="No connections"
                    hint="Seeded connections will appear here, including refresh and reauth-required examples."
                  />
                </TableCell>
              </TableRow>
            ) : (
              connections.map((c) => (
                <TableRow
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "cursor-pointer border-zinc-800 hover:bg-zinc-800/40",
                    "[&>td:first-child]:sticky [&>td:first-child]:left-0 [&>td:first-child]:bg-zinc-950/95 [&>td:first-child]:z-10",
                  )}
                >
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Cable className="size-3.5 text-emerald-400" />
                      <span className="font-mono text-xs text-zinc-200">
                        {c.providerKey}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-zinc-400">
                    {c.adapterKey}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-zinc-400">
                    {c.providerAccountRef ?? "—"}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell>
                    <div className="w-32">
                      <div className="text-[11px] text-zinc-400">
                        <RelativeTime value={c.accessExpiresAt} warnWithinHours={24} />
                      </div>
                      <LifetimeBar
                        createdAt={c.createdAt}
                        expiresAt={c.accessExpiresAt}
                      />
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400">
                    <RelativeTime value={c.refreshAfter} />
                  </TableCell>
                  <TableCell className="font-mono text-xs tabular-nums text-zinc-300">
                    {c.refreshGeneration}
                  </TableCell>
                  <TableCell className="font-mono text-[11px]">
                    {c.lastErrorCode ? (
                      <span className="text-rose-300">{c.lastErrorCode}</span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${c.providerKey}`}
                          onClick={(e) => e.stopPropagation()}
                          className="size-8 min-h-8 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        >
                          <MoreHorizontal className="size-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="border-zinc-800 bg-zinc-900 text-zinc-200"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <DropdownMenuItem
                          onSelect={() => {
                            qc.invalidateQueries({
                              queryKey: ["connection-status", c.id],
                            });
                            setSelectedId(c.id);
                          }}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <Cable className="size-3.5 text-zinc-300" />
                          Status
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => refreshM.mutate(c.id)}
                          disabled={refreshM.isPending}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <RefreshCw className="size-3.5 text-amber-400" />
                          Refresh
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => credM.mutate(c.id)}
                          disabled={credM.isPending}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <KeyRound className="size-3.5 text-emerald-400" />
                          Get Credential
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => reauthM.mutate(c.id)}
                          disabled={reauthM.isPending}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <RefreshCw className="size-3.5 text-amber-400" />
                          Reauthorize
                        </DropdownMenuItem>
                        {c.status === "reauth_required" && (
                          <DropdownMenuItem
                            onSelect={() => {
                              setRecoverTarget(c);
                              setRecoverToken("");
                            }}
                            disabled={recoverM.isPending}
                            className="text-amber-200 hover:bg-amber-900/30 focus:bg-amber-900/30"
                          >
                            <LifeBuoy className="size-3.5 text-amber-400" />
                            Recover
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator className="bg-zinc-800" />
                        <DropdownMenuItem
                          onSelect={() => setRevokeTarget(c)}
                          className="text-rose-300 hover:bg-rose-900/30 focus:bg-rose-900/30"
                        >
                          <ShieldOff className="size-3.5" />
                          Revoke
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Get Credential Result */}
      <Dialog open={credOpen} onOpenChange={(o) => {
        setCredOpen(o);
        if (!o) {
          setCredResult(null);
          setCredTarget(null);
        }
      }}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              <KeyRound className="size-4 text-emerald-400" />
              Live Credential
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              The current active version of the access_token binding, revealed
              on demand and audited as{" "}
              <span className="font-mono text-zinc-400">connection.credential</span>.
              Refresh tokens and TOTP seeds are never returned.
            </DialogDescription>
          </DialogHeader>
          {credResult ? (
            <>
              <SecretValueReveal
                value={credResult.credential.value}
                label="access_token"
                autoFocusReveal
                notice="Cache-Control: no-store · audited reveal · generation guarded"
              />
              <div className="grid grid-cols-3 gap-2 text-xs">
                <Detail
                  label="Generation"
                  value={credResult.credential.generation}
                  mono
                />
                <Detail
                  label="Refreshed"
                  value={credResult.credential.refreshed ? "yes" : "no"}
                  mono
                />
                <Detail
                  label="Expires"
                  value={
                    <RelativeTime value={credResult.credential.expiresAt} />
                  }
                />
              </div>
            </>
          ) : (
            <Skeleton className="h-12 w-full bg-zinc-800" />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCredOpen(false);
                setCredResult(null);
              }}
              className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
            >
              <X className="size-3.5" />
              Close & forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title="Revoke connection?"
        description={
          revokeTarget ? (
            <>
              Revoking{" "}
              <span className="font-mono text-zinc-200">
                {revokeTarget.providerKey}/{revokeTarget.providerAccountRef ?? revokeTarget.adapterKey}
              </span>{" "}
              attempts a provider-side revoke if supported and marks the
              connection revoked locally.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Revoke"
        destructive
        onConfirm={() => revokeTarget && revokeM.mutate(revokeTarget.id)}
      />

      {/* Recover dialog (only for reauth_required connections). Resets to
          active and re-arms the watchdog refresh cycle. Optionally accepts
          a new refresh token if the upstream credential was manually
          re-issued. */}
      <Dialog
        open={!!recoverTarget}
        onOpenChange={(o) => {
          if (!o) {
            setRecoverTarget(null);
            setRecoverToken("");
          }
        }}
      >
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              <LifeBuoy className="size-4 text-amber-400" />
              Recover connection?
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              This will reset{" "}
              <span className="font-mono text-zinc-300">
                {recoverTarget?.providerKey}/{recoverTarget?.providerAccountRef ?? recoverTarget?.adapterKey}
              </span>{" "}
              to <span className="font-mono text-emerald-300">active</span> and
              re-arm the refresh cycle. Optionally provide the{" "}
              {recoverUsesAccessToken ? "access" : "refresh"} token you
              re-issued at the provider.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label
              htmlFor="recover-token"
              className="text-[11px] uppercase tracking-wide text-zinc-500"
            >
              New {recoverUsesAccessToken ? "access" : "refresh"} token (optional)
            </Label>
            <Textarea
              id="recover-token"
              value={recoverToken}
              onChange={(e) => setRecoverToken(e.target.value)}
              rows={3}
              placeholder="paste the new token — encrypted and stored as a new secret version"
              className="border-zinc-800 bg-zinc-950/60 font-mono text-xs text-zinc-200"
            />
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-2 text-[10px] text-zinc-500">
              If supplied, the new token is encrypted as a new secret version
              and the prior version is retired. A{" "}
              <span className="font-mono text-zinc-400">recover</span> rotation
              run is recorded for audit.
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRecoverTarget(null);
                setRecoverToken("");
              }}
              className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </Button>
            <Button
              disabled={recoverM.isPending || !recoverTarget}
              onClick={() =>
                recoverTarget &&
                recoverM.mutate({
                  id: recoverTarget.id,
                  token: recoverToken.trim() || undefined,
                  isAccessToken: recoverUsesAccessToken,
                })
              }
              className="bg-amber-600 text-white hover:bg-amber-500"
            >
              {recoverM.isPending ? "Recovering…" : "Recover connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail sheet */}
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
              {selected?.providerKey}/{selected?.providerAccountRef ?? selected?.adapterKey}
            </SheetTitle>
            <SheetDescription className="text-xs text-zinc-500">
              Bindings and lifecycle timeline.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {!selected ? (
              <Skeleton className="h-32 w-full bg-zinc-800" />
            ) : (
              <>
                <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
                  <Detail label="Status" value={<StatusBadge status={selected.status} />} />
                  <Detail label="Generation" value={selected.refreshGeneration} mono />
                  <Detail
                    label="Access Expires"
                    value={<RelativeTime value={selected.accessExpiresAt} />}
                  />
                  <Detail
                    label="Refresh After"
                    value={<RelativeTime value={selected.refreshAfter} />}
                  />
                  <Detail
                    label="Last Refreshed"
                    value={<RelativeTime value={selected.lastRefreshedAt} fallback="never" />}
                  />
                  <Detail
                    label="Reauth Required"
                    value={<RelativeTime value={selected.reauthRequiredAt} fallback="no" />}
                  />
                </div>

                <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
                  Bindings
                </h3>
                {(selected.bindings ?? []).length === 0 ? (
                  <div className="text-xs text-zinc-500">No bindings.</div>
                ) : (
                  <ul className="space-y-1.5">
                    {(selected.bindings ?? []).map((b) => (
                      <li
                        key={b.id}
                        className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs"
                      >
                        <Badge
                          variant="outline"
                          className="border-amber-700/40 bg-amber-500/10 font-mono text-[10px] text-amber-300"
                        >
                          {b.purpose}
                        </Badge>
                        <span className="font-mono text-zinc-200">
                          {b.secretPath ?? b.vaultSecretId}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                <h3 className="mb-2 mt-5 text-xs uppercase tracking-wide text-zinc-500">
                  Lifecycle Timeline
                </h3>
                <ol className="relative ml-3 border-l border-zinc-800 pl-4 text-xs">
                  <TimelineItem
                    label="Created"
                    value={<AbsoluteTime value={selected.createdAt} />}
                  />
                  {selected.lastRefreshedAt && (
                    <TimelineItem
                      label="Last Refreshed"
                      value={<AbsoluteTime value={selected.lastRefreshedAt} />}
                    />
                  )}
                  {selected.refreshAfter && (
                    <TimelineItem
                      label="Refresh After"
                      value={<AbsoluteTime value={selected.refreshAfter} />}
                    />
                  )}
                  {selected.accessExpiresAt && (
                    <TimelineItem
                      label="Access Expires"
                      value={<AbsoluteTime value={selected.accessExpiresAt} />}
                    />
                  )}
                  {selected.reauthRequiredAt && (
                    <TimelineItem
                      label="Reauth Required"
                      value={<AbsoluteTime value={selected.reauthRequiredAt} />}
                    />
                  )}
                </ol>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function LifetimeBar({
  createdAt,
  expiresAt,
}: {
  createdAt: string;
  expiresAt: string | null;
}) {
  if (!expiresAt) return null;
  const start = +new Date(createdAt);
  const end = +new Date(expiresAt);
  const now = Date.now();
  const total = Math.max(end - start, 1);
  const elapsed = Math.min(Math.max(now - start, 0), total);
  const pct = (elapsed / total) * 100;
  const tone =
    pct > 90
      ? "bg-rose-500/80"
      : pct > 70
        ? "bg-amber-500/80"
        : "bg-emerald-500/80";
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      <div
        className={cn("h-full transition-all", tone)}
        style={{ width: `${pct}%` }}
      />
    </div>
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
