"use client";

import { useMemo, useState } from "react";
import { Grid3x3, List, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
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
  type ClientListItem,
  type Permission,
  type SecretListItem,
} from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge } from "../StatusBadge";
import { EmptyState, ForbiddenState, isApiWarmingError, isForbidden } from "../Status";
import { cn } from "@/lib/utils";

const PERM_TONE: Record<Permission, string> = {
  "value:read": "border-emerald-700/40 bg-emerald-500/10 text-emerald-300",
  "connection:refresh": "border-amber-700/40 bg-amber-500/10 text-amber-300",
  "metadata:read": "border-zinc-700/60 bg-zinc-500/10 text-zinc-300",
  "version:create": "border-teal-700/40 bg-teal-500/10 text-teal-300",
  rotate: "border-amber-700/40 bg-amber-500/10 text-amber-300",
  revoke: "border-rose-700/40 bg-rose-500/10 text-rose-300",
  "audit:read": "border-sky-700/40 bg-sky-500/10 text-sky-300",
};

export function AccessGrantsView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);
  const qc = useQueryClient();

  const [mode, setMode] = useState<"matrix" | "list">("matrix");
  const [clientSearch, setClientSearch] = useState("");
  const [secretSearch, setSecretSearch] = useState("");
  const [editCell, setEditCell] = useState<{
    clientId: string;
    secretId: string;
  } | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const grantsQ = useQuery({
    queryKey: ["grants", workspaceId, refreshTick],
    queryFn: () => api.listGrants(workspaceId),
    enabled: !!workspaceId,
  });
  const clientsQ = useQuery({
    queryKey: ["clients", workspaceId, refreshTick],
    queryFn: () => api.listClients(workspaceId),
    enabled: !!workspaceId,
  });
  const secretsQ = useQuery({
    queryKey: ["secrets", workspaceId, refreshTick],
    queryFn: () => api.listSecrets(workspaceId),
    enabled: !!workspaceId,
  });

  const warming =
    grantsQ.isError && isApiWarmingError(grantsQ.error);
  const forbidden =
    grantsQ.isError && isForbidden(grantsQ.error) ||
    clientsQ.isError && isForbidden(clientsQ.error) ||
    secretsQ.isError && isForbidden(secretsQ.error);

  const clients = clientsQ.data?.clients ?? [];
  const secrets = secretsQ.data?.secrets ?? [];

  // Index grants by (clientId, secretId) -> Set<Permission>
  const grantIndex = useMemo(() => {
    const idx = new Map<string, Set<Permission>>();
    for (const g of grantsQ.data?.grants ?? []) {
      const key = `${g.serviceClientId}|${g.vaultSecretId}`;
      const perms = new Set(
        g.permissions.split(",").filter(Boolean) as Permission[],
      );
      idx.set(key, perms);
    }
    return idx;
  }, [grantsQ.data]);

  const visibleClients = useMemo(() => {
    const q = clientSearch.trim().toLowerCase();
    const list = q
      ? clients.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            c.publicId.toLowerCase().includes(q),
        )
      : clients;
    return list.slice(0, 8);
  }, [clients, clientSearch]);

  const visibleSecrets = useMemo(() => {
    const q = secretSearch.trim().toLowerCase();
    const list = q
      ? secrets.filter(
          (s) =>
            s.path.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q),
        )
      : secrets;
    return list.slice(0, 8);
  }, [secrets, secretSearch]);

  const deleteM = useMutation({
    mutationFn: (id: string) => api.deleteGrant(id),
    onSuccess: () => {
      toast.success("Grant removed");
      qc.invalidateQueries({ queryKey: ["grants", workspaceId] });
    },
    onError: (e) => toast.error(`Remove failed: ${(e as Error).message}`),
  });
  const upsertM = useMutation({
    mutationFn: (input: {
      serviceClientId: string;
      vaultSecretId: string;
      permissions: string;
    }) => api.createGrant(input),
    onSuccess: () => {
      toast.success("Grant updated");
      qc.invalidateQueries({ queryKey: ["grants", workspaceId] });
    },
    onError: (e) => toast.error(`Update failed: ${(e as Error).message}`),
  });

  const grants = grantsQ.data?.grants ?? [];

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — grants list may be empty.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Access Grants</h1>
          <p className="text-xs text-zinc-500">
            Per-client secret grants with explicit, least-privilege permissions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs
            value={mode}
            onValueChange={(v) => setMode(v as "matrix" | "list")}
          >
            <TabsList className="border-zinc-800 bg-zinc-900/60">
              <TabsTrigger
                value="matrix"
                className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100"
              >
                <Grid3x3 className="size-3.5" />
                Matrix
              </TabsTrigger>
              <TabsTrigger
                value="list"
                className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100"
              >
                <List className="size-3.5" />
                List
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button
            onClick={() => setNewOpen(true)}
            disabled={forbidden}
            className="min-h-11 bg-emerald-600 text-white hover:bg-emerald-500"
          >
            <Plus className="size-4" />
            New Grant
          </Button>
        </div>
      </div>

      {forbidden ? (
        <ForbiddenState />
      ) : mode === "matrix" ? (
        <MatrixView
          clients={visibleClients}
          secrets={visibleSecrets}
          grantIndex={grantIndex}
          onEdit={(clientId, secretId) =>
            setEditCell({ clientId, secretId })
          }
          clientSearch={clientSearch}
          secretSearch={secretSearch}
          setClientSearch={setClientSearch}
          setSecretSearch={setSecretSearch}
          loading={grantsQ.isLoading || clientsQ.isLoading || secretsQ.isLoading}
        />
      ) : (
        <ListView
          grants={grants}
          loading={grantsQ.isLoading}
          onRemove={(id) => deleteM.mutate(id)}
        />
      )}

      {editCell && (
        <EditGrantDialog
          cell={editCell}
          initialPerms={
            grantIndex.get(`${editCell.clientId}|${editCell.secretId}`) ??
            new Set()
          }
          clients={clients}
          secrets={secrets}
          onOpenChange={(o) => !o && setEditCell(null)}
          onSubmit={(perms) => {
            upsertM.mutate({
              serviceClientId: editCell.clientId,
              vaultSecretId: editCell.secretId,
              permissions: Array.from(perms).join(","),
            });
            setEditCell(null);
          }}
          pending={upsertM.isPending}
        />
      )}

      <NewGrantDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        clients={clients}
        secrets={secrets}
        pending={upsertM.isPending}
        onSubmit={(input) => {
          upsertM.mutate(input);
          setNewOpen(false);
        }}
      />
    </div>
  );
}

function MatrixView({
  clients,
  secrets,
  grantIndex,
  onEdit,
  clientSearch,
  secretSearch,
  setClientSearch,
  setSecretSearch,
  loading,
}: {
  clients: ClientListItem[];
  secrets: SecretListItem[];
  grantIndex: Map<string, Set<Permission>>;
  onEdit: (clientId: string, secretId: string) => void;
  clientSearch: string;
  secretSearch: string;
  setClientSearch: (s: string) => void;
  setSecretSearch: (s: string) => void;
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full bg-zinc-800/60" />
        ))}
      </div>
    );
  }
  if (clients.length === 0 || secrets.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="Nothing to grant yet"
        hint="Seed the vault to populate service clients and secrets, then come back to manage grants."
      />
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Input
          placeholder="Search clients…"
          value={clientSearch}
          onChange={(e) => setClientSearch(e.target.value)}
          className="h-9 max-w-xs border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200 placeholder:text-zinc-600"
          aria-label="Search clients"
        />
        <Input
          placeholder="Search secrets…"
          value={secretSearch}
          onChange={(e) => setSecretSearch(e.target.value)}
          className="h-9 max-w-xs border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200 placeholder:text-zinc-600"
          aria-label="Search secrets"
        />
      </div>
      <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-900/40">
        <table className="vault-matrix w-full text-xs">
          <thead className="bg-zinc-950/60">
            <tr>
              <th className="sticky left-0 z-10 bg-zinc-950/95 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wide text-zinc-500">
                Client \ Secret
              </th>
              {secrets.map((s) => (
                <th
                  key={s.id}
                  className="border-l border-zinc-800 px-3 py-2 text-left align-top"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        tabIndex={-1}
                        className="block max-w-[140px] truncate font-mono text-[10px] text-zinc-300 hover:text-zinc-100"
                      >
                        {s.path}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      className="border border-zinc-700 bg-zinc-900 font-mono text-[10px] text-zinc-200"
                    >
                      {s.path}
                    </TooltipContent>
                  </Tooltip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-t border-zinc-800 hover:bg-zinc-800/30">
                <td className="sticky left-0 z-10 bg-zinc-950/95 px-3 py-2 align-top">
                  <div className="text-zinc-200">{c.name}</div>
                  <div className="font-mono text-[10px] text-zinc-500">
                    {c.clientType}
                  </div>
                </td>
                {secrets.map((s) => {
                  const perms =
                    grantIndex.get(`${c.id}|${s.id}`) ?? new Set<Permission>();
                  return (
                    <td
                      key={s.id}
                      className="border-l border-zinc-800 px-2 py-2 align-top"
                    >
                      <button
                        type="button"
                        onClick={() => onEdit(c.id, s.id)}
                        className="block min-h-11 min-w-[80px] rounded-md border border-zinc-800 bg-zinc-900/40 px-2 py-1 text-left transition-colors hover:bg-zinc-800/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        aria-label={`Edit grant for ${c.name} on ${s.path}`}
                      >
                        {perms.size === 0 ? (
                          <span className="text-[10px] text-zinc-600 opacity-40">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {Array.from(perms).map((p) => (
                              <span
                                key={p}
                                className={cn(
                                  "rounded border px-1 py-0.5 font-mono text-[9px]",
                                  PERM_TONE[p],
                                )}
                              >
                                {p.split(":")[1] ?? p}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ListView({
  grants,
  loading,
  onRemove,
}: {
  grants: {
    id: string;
    serviceClientName: string;
    secretPath: string;
    secretName: string;
    permissions: string;
  }[];
  loading: boolean;
  onRemove: (id: string) => void;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full bg-zinc-800/60" />
        ))}
      </div>
    );
  }
  if (grants.length === 0) {
    return (
      <EmptyState
        icon={ShieldCheck}
        title="No grants"
        hint="Use the matrix view or the New Grant button to authorize clients."
      />
    );
  }
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <Table className="vault-table">
        <TableHeader>
          <TableRow className="border-zinc-800 hover:bg-transparent">
            <TableHead className="text-zinc-400">Client</TableHead>
            <TableHead className="text-zinc-400">Secret</TableHead>
            <TableHead className="text-zinc-400">Permissions</TableHead>
            <TableHead className="w-10 text-zinc-400" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {grants.map((g) => {
            const perms = g.permissions
              .split(",")
              .filter(Boolean) as Permission[];
            return (
              <TableRow
                key={g.id}
                className="border-zinc-800 hover:bg-zinc-800/40"
              >
                <TableCell className="text-zinc-200">{g.serviceClientName}</TableCell>
                <TableCell className="font-mono text-[11px] text-zinc-300">
                  {g.secretPath}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {perms.map((p) => (
                      <span
                        key={p}
                        className={cn(
                          "rounded border px-1 py-0.5 font-mono text-[9px]",
                          PERM_TONE[p],
                        )}
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Remove grant"
                    onClick={() => onRemove(g.id)}
                    className="size-8 text-rose-300 hover:bg-rose-900/30 hover:text-rose-200"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function EditGrantDialog({
  cell,
  initialPerms,
  clients,
  secrets,
  onOpenChange,
  onSubmit,
  pending,
}: {
  cell: { clientId: string; secretId: string };
  initialPerms: Set<Permission>;
  clients: ClientListItem[];
  secrets: SecretListItem[];
  onOpenChange: (o: boolean) => void;
  onSubmit: (perms: Set<Permission>) => void;
  pending: boolean;
}) {
  const [perms, setPerms] = useState<Set<Permission>>(new Set(initialPerms));
  const client = clients.find((c) => c.id === cell.clientId);
  const secret = secrets.find((s) => s.id === cell.secretId);

  function toggle(p: Permission) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">Edit Grant</DialogTitle>
          <DialogDescription className="text-zinc-400">
            {client?.name ?? "Client"} →{" "}
            <span className="font-mono text-zinc-300">
              {secret?.path ?? "secret"}
            </span>
          </DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() => onSubmit(perms)}
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {pending ? "Saving…" : "Save grant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewGrantDialog({
  open,
  onOpenChange,
  clients,
  secrets,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  clients: ClientListItem[];
  secrets: SecretListItem[];
  pending: boolean;
  onSubmit: (input: {
    serviceClientId: string;
    vaultSecretId: string;
    permissions: string;
  }) => void;
}) {
  const [clientId, setClientId] = useState("");
  const [secretId, setSecretId] = useState("");
  const [perms, setPerms] = useState<Set<Permission>>(
    new Set(["value:read"] as Permission[]),
  );

  function toggle(p: Permission) {
    setPerms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">New Grant</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Authorize a service client to access a secret with explicit
            permissions. The grant is unique per (client, secret) pair.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Client
            </Label>
            <Select value={clientId || undefined} onValueChange={setClientId}>
              <SelectTrigger className="text-xs">
                <SelectValue placeholder="Choose client" />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 max-h-60">
                {clients.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}{" "}
                    <span className="text-zinc-500 font-mono text-[10px]">
                      ({c.clientType})
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Secret
            </Label>
            <Select value={secretId || undefined} onValueChange={setSecretId}>
              <SelectTrigger className="text-xs">
                <SelectValue placeholder="Choose secret" />
              </SelectTrigger>
              <SelectContent className="border-zinc-800 bg-zinc-900 max-h-60">
                {secrets.map((s) => (
                  <SelectItem key={s.id} value={s.id} className="font-mono">
                    {s.path}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Permissions
            </Label>
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
          </div>
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
            disabled={pending || !clientId || !secretId || perms.size === 0}
            onClick={() =>
              onSubmit({
                serviceClientId: clientId,
                vaultSecretId: secretId,
                permissions: Array.from(perms).join(","),
              })
            }
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {pending ? "Saving…" : "Create Grant"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
