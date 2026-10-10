"use client";

import { useMemo, useState } from "react";
import {
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  ShieldX,
  Timer,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  ALL_PERMISSIONS,
  type LeaseListItem,
  type Permission,
} from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge } from "../StatusBadge";
import { RelativeTime } from "../RelativeTime";
import { EmptyState, isApiWarmingError, isForbidden } from "../Status";
import { cn } from "@/lib/utils";

const TTL_OPTIONS: { label: string; seconds: number }[] = [
  { label: "5 minutes", seconds: 300 },
  { label: "15 minutes", seconds: 900 },
  { label: "1 hour", seconds: 3600 },
  { label: "24 hours", seconds: 86400 },
];

const PERM_TONE: Record<Permission, string> = {
  "value:read": "border-emerald-700/40 bg-emerald-500/10 text-emerald-300",
  "connection:refresh": "border-amber-700/40 bg-amber-500/10 text-amber-300",
  "metadata:read": "border-zinc-700/60 bg-zinc-500/10 text-zinc-300",
  "version:create": "border-teal-700/40 bg-teal-500/10 text-teal-300",
  rotate: "border-amber-700/40 bg-amber-500/10 text-amber-300",
  revoke: "border-rose-700/40 bg-rose-500/10 text-rose-300",
  "audit:read": "border-sky-700/40 bg-sky-500/10 text-sky-300",
};

export function LeasesView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const authMode = useVaultStore((s) => s.authMode);
  const qc = useQueryClient();

  const [activeOnly, setActiveOnly] = useState(true);
  const [issueOpen, setIssueOpen] = useState(false);

  const leasesQ = useQuery({
    queryKey: ["leases", workspaceId, activeOnly],
    queryFn: () =>
      api.listAllLeases({
        activeOnly,
        workspaceId: workspaceId || undefined,
      }),
    refetchInterval: 10_000,
  });

  const secretsQ = useQuery({
    queryKey: ["secrets", workspaceId, 0],
    queryFn: () => api.listSecrets(workspaceId),
    enabled: !!workspaceId && issueOpen,
    staleTime: 60_000,
  });
  const clientsQ = useQuery({
    queryKey: ["clients", workspaceId, 0],
    queryFn: () => api.listClients(workspaceId),
    enabled: !!workspaceId && issueOpen,
    staleTime: 60_000,
  });

  const revokeM = useMutation({
    mutationFn: (id: string) => api.revokeLease(id),
    onSuccess: () => {
      toast.success("Lease revoked");
      qc.invalidateQueries({ queryKey: ["leases"] });
    },
    onError: (e) => toast.error(`Revoke failed: ${(e as Error).message}`),
  });

  const warming = leasesQ.isError && isApiWarmingError(leasesQ.error);
  const forbidden = leasesQ.isError && isForbidden(leasesQ.error);
  const leases = leasesQ.data?.leases ?? [];

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — leases list may be empty.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Secret Leases</h1>
          <p className="text-xs text-zinc-500">
            Short-lived, revocable credential delivery. A lease grants a client
            time-boxed access to a secret without exposing the long-lived
            grant.
          </p>
        </div>
        <Button
          onClick={() => setIssueOpen(true)}
          className="min-h-11 bg-emerald-600 text-white hover:bg-emerald-500"
          disabled={authMode === "client"}
          title={
            authMode === "client"
              ? "Issue is admin-only — exit client view"
              : "Issue a new lease"
          }
        >
          <Plus className="size-4" />
          Issue Lease
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300">
          <Switch checked={activeOnly} onCheckedChange={setActiveOnly} />
          Active only
        </label>
        <div className="ml-auto text-xs text-zinc-500">
          {leases.length} lease{leases.length === 1 ? "" : "s"}
          {activeOnly ? " · active" : " · all"}
        </div>
      </div>

      {forbidden ? (
        <div className="rounded-lg border border-amber-800/50 bg-amber-950/30 px-6 py-10 text-center text-sm text-amber-200">
          Not permitted in client view — switch back to admin to manage leases.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
          <Table className="vault-table">
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="text-zinc-400">Secret Path</TableHead>
                <TableHead className="text-zinc-400">Client</TableHead>
                <TableHead className="text-zinc-400">Permissions</TableHead>
                <TableHead className="text-zinc-400">Issued</TableHead>
                <TableHead className="text-zinc-400">Expires</TableHead>
                <TableHead className="text-zinc-400">Status</TableHead>
                <TableHead className="w-10 text-zinc-400" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {leasesQ.isLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i} className="border-zinc-800">
                    <TableCell colSpan={7}>
                      <Skeleton className="h-7 w-full bg-zinc-800/60" />
                    </TableCell>
                  </TableRow>
                ))
              ) : leases.length === 0 ? (
                <TableRow className="border-zinc-800">
                  <TableCell colSpan={7}>
                    <EmptyState
                      icon={KeyRound}
                      title="No active leases"
                      hint="Issue one to grant a client time-boxed access to a secret. Active leases are revoked automatically when they expire."
                    />
                  </TableCell>
                </TableRow>
              ) : (
                leases.map((l) => (
                  <LeaseRow
                    key={l.id}
                    lease={l}
                    onRevoke={() => revokeM.mutate(l.id)}
                    pending={revokeM.isPending}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      <IssueLeaseDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        secrets={secretsQ.data?.secrets ?? []}
        clients={clientsQ.data?.clients ?? []}
        loadingMeta={secretsQ.isLoading || clientsQ.isLoading}
        pending={false}
        onSubmit={(input) => {
          qc.invalidateQueries({ queryKey: ["leases"] });
          toast.success("Lease issued", {
            description: `${input.serviceClientName} → ${input.secretPath} (${input.ttlLabel})`,
          });
          setIssueOpen(false);
        }}
      />
    </div>
  );
}

function LeaseRow({
  lease,
  onRevoke,
  pending,
}: {
  lease: LeaseListItem;
  onRevoke: () => void;
  pending: boolean;
}) {
  const perms = lease.grantedPermissions
    .split(",")
    .filter(Boolean) as Permission[];
  const now = Date.now();
  const expiresAt = lease.expiresAt ? +new Date(lease.expiresAt) : 0;
  const msLeft = expiresAt - now;
  const imminent = lease.status === "active" && msLeft > 0 && msLeft < 5 * 60 * 1000;
  const expired = lease.status === "active" && msLeft <= 0;

  return (
    <TableRow
      className={cn(
        "border-zinc-800 hover:bg-zinc-800/40",
        "[&>td:first-child]:sticky [&>td:first-child]:left-0 [&>td:first-child]:bg-zinc-950/95 [&>td:first-child]:z-10",
      )}
    >
      <TableCell className="font-mono text-xs text-zinc-200">
        {lease.secretPath ?? lease.vaultSecretId}
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-200">
            {lease.serviceClientName ?? lease.serviceClientId.slice(0, 8)}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {perms.length === 0 ? (
            <span className="text-[10px] text-zinc-600">—</span>
          ) : (
            perms.map((p) => (
              <span
                key={p}
                className={cn(
                  "rounded border px-1 py-0.5 font-mono text-[9px]",
                  PERM_TONE[p],
                )}
              >
                {p}
              </span>
            ))
          )}
        </div>
      </TableCell>
      <TableCell className="text-[11px] text-zinc-400">
        <RelativeTime value={lease.issuedAt} />
      </TableCell>
      <TableCell>
        {lease.status === "active" ? (
          <div className="flex items-center gap-1.5">
            <Timer
              className={cn(
                "size-3",
                imminent || expired ? "text-amber-400" : "text-zinc-500",
              )}
            />
            <span
              className={cn(
                "font-mono text-[11px]",
                imminent || expired
                  ? "text-amber-300"
                  : "text-zinc-300",
              )}
            >
              <RelativeTime value={lease.expiresAt} />
            </span>
            {imminent && (
              <span className="text-[10px] font-mono text-amber-400">
                · {formatCountdown(msLeft)}
              </span>
            )}
          </div>
        ) : (
          <span className="text-[11px] text-zinc-500">
            <RelativeTime value={lease.expiresAt} />
          </span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={lease.status} />
      </TableCell>
      <TableCell>
        {lease.status === "active" && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Lease actions"
                className="size-8 min-h-8 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-zinc-800 bg-zinc-900 text-zinc-200"
            >
              <DropdownMenuItem
                onSelect={onRevoke}
                disabled={pending}
                className="text-rose-300 hover:bg-rose-900/30 focus:bg-rose-900/30"
              >
                <ShieldX className="size-3.5" />
                Revoke lease
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TableCell>
    </TableRow>
  );
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return "expired";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, "0")}s`;
}

function IssueLeaseDialog({
  open,
  onOpenChange,
  secrets,
  clients,
  loadingMeta,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  secrets: { id: string; path: string }[];
  clients: { id: string; name: string; clientType: string }[];
  loadingMeta: boolean;
  pending: boolean;
  onSubmit: (input: {
    secretId: string;
    secretPath: string;
    serviceClientId: string;
    serviceClientName: string;
    permissions: Permission[];
    ttlSeconds: number;
    ttlLabel: string;
  }) => void;
}) {
  const [secretId, setSecretId] = useState("");
  const [clientId, setClientId] = useState("");
  const [perms, setPerms] = useState<Set<Permission>>(
    new Set<Permission>(["value:read"]),
  );
  const [ttlSeconds, setTtlSeconds] = useState<number>(900);
  const [submitting, setSubmitting] = useState(false);

  function toggle(p: Permission) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  async function submit() {
    if (!secretId || !clientId || perms.size === 0) return;
    setSubmitting(true);
    try {
      const ttl = TTL_OPTIONS.find((t) => t.seconds === ttlSeconds);
      await api.issueLease(secretId, {
        serviceClientId: clientId,
        permissions: Array.from(perms),
        ttlSeconds,
      });
      onSubmit({
        secretId,
        secretPath: secrets.find((s) => s.id === secretId)?.path ?? "",
        serviceClientId: clientId,
        serviceClientName:
          clients.find((c) => c.id === clientId)?.name ?? "",
        permissions: Array.from(perms),
        ttlSeconds,
        ttlLabel: ttl?.label ?? `${ttlSeconds}s`,
      });
      setSecretId("");
      setClientId("");
      setPerms(new Set<Permission>(["value:read"]));
      setTtlSeconds(900);
    } catch (e) {
      toast.error(`Issue failed: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <KeyRound className="size-4 text-emerald-400" />
            Issue Lease
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Grant a service client a short-lived, revocable credential for a
            secret. The lease is recorded as{" "}
            <span className="font-mono text-zinc-300">lease.issue</span> in the
            audit log.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {loadingMeta ? (
            <div className="space-y-2">
              <Skeleton className="h-9 w-full bg-zinc-800" />
              <Skeleton className="h-9 w-full bg-zinc-800" />
            </div>
          ) : (
            <>
              <Field label="Secret">
                <Select
                  value={secretId || undefined}
                  onValueChange={setSecretId}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Choose secret" />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-900 max-h-60">
                    {secrets.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No secrets in workspace
                      </SelectItem>
                    ) : (
                      secrets.map((s) => (
                        <SelectItem key={s.id} value={s.id} className="font-mono">
                          {s.path}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Client">
                <Select
                  value={clientId || undefined}
                  onValueChange={setClientId}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue placeholder="Choose client" />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-900 max-h-60">
                    {clients.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No clients in workspace
                      </SelectItem>
                    ) : (
                      clients.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}{" "}
                          <span className="text-zinc-500 font-mono text-[10px]">
                            ({c.clientType})
                          </span>
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </Field>

              <Field label="Permissions">
                <div className="grid grid-cols-2 gap-1.5">
                  {ALL_PERMISSIONS.map((p) => (
                    <label
                      key={p}
                      className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1.5 text-[11px] font-mono text-zinc-300 select-none"
                    >
                      <Checkbox
                        checked={perms.has(p)}
                        onCheckedChange={() => toggle(p)}
                      />
                      {p}
                    </label>
                  ))}
                </div>
              </Field>

              <Field label="TTL">
                <Select
                  value={String(ttlSeconds)}
                  onValueChange={(v) => setTtlSeconds(Number(v))}
                >
                  <SelectTrigger className="text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="border-zinc-800 bg-zinc-900">
                    {TTL_OPTIONS.map((t) => (
                      <SelectItem key={t.seconds} value={String(t.seconds)}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </Button>
          <Button
            disabled={
              pending ||
              submitting ||
              !secretId ||
              !clientId ||
              perms.size === 0
            }
            onClick={submit}
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Issuing…
              </>
            ) : (
              "Issue Lease"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </Label>
      {children}
    </div>
  );
}
