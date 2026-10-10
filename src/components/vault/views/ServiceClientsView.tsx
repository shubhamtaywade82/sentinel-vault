"use client";

import { useMemo, useState } from "react";
import {
  Bot,
  MoreHorizontal,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { Checkbox } from "@/components/ui/checkbox";

import { api } from "@/lib/vault/client";
import type { ClientListItem, ClientType } from "@/lib/vault/types";
import { ALL_PERMISSIONS, type Permission } from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge } from "../StatusBadge";
import { RelativeTime } from "../RelativeTime";
import { CopyButton } from "../CopyButton";
import { ConfirmDialog } from "../ConfirmDialog";
import { SecretValueReveal } from "../SecretValueReveal";
import { EmptyState, ForbiddenState, isApiWarmingError, isForbidden } from "../Status";
import { cn } from "@/lib/utils";

const CLIENT_TYPES: ClientType[] = ["bot", "app", "gateway", "cli", "mcp", "worker"];

export function ServiceClientsView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);
  const qc = useQueryClient();

  const [newOpen, setNewOpen] = useState(false);
  const [credentialResult, setCredentialResult] = useState<string | null>(null);
  const [credentialClientName, setCredentialClientName] = useState<string>("");
  const [credentialOpen, setCredentialOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<ClientListItem | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ClientListItem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const clientsQ = useQuery({
    queryKey: ["clients", workspaceId, refreshTick],
    queryFn: () => api.listClients(workspaceId),
    enabled: !!workspaceId,
  });
  const workspacesQ = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.listWorkspaces(),
  });
  const grantsQ = useQuery({
    queryKey: ["grants", workspaceId, refreshTick],
    queryFn: () => api.listGrants(workspaceId),
    enabled: !!workspaceId,
  });
  const secretsQ = useQuery({
    queryKey: ["secrets", workspaceId, refreshTick],
    queryFn: () => api.listSecrets(workspaceId),
    enabled: !!workspaceId,
  });

  const warming = clientsQ.isError && isApiWarmingError(clientsQ.error);
  const forbidden = clientsQ.isError && isForbidden(clientsQ.error);
  const clients = clientsQ.data?.clients ?? [];

  const selectedClient = useMemo(
    () => clients.find((c) => c.id === selectedId) ?? null,
    [clients, selectedId],
  );
  const clientGrants = useMemo(
    () => (grantsQ.data?.grants ?? []).filter((g) => g.serviceClientId === selectedId),
    [grantsQ.data, selectedId],
  );

  // Mutations
  const createM = useMutation({
    mutationFn: api.createClient,
    onSuccess: (res) => {
      toast.success("Service client created — credential shown once");
      setCredentialResult(res.credential);
      setCredentialClientName(res.client.name);
      setCredentialOpen(true);
      setNewOpen(false);
      qc.invalidateQueries({ queryKey: ["clients", workspaceId] });
    },
    onError: (e) => toast.error(`Create failed: ${(e as Error).message}`),
  });
  const rotateCredM = useMutation({
    mutationFn: (id: string) => api.rotateClientCredential(id),
    onSuccess: (res) => {
      toast.success("Credential rotated — new credential shown once");
      setCredentialResult(res.credential);
      setCredentialClientName(res.client.name);
      setCredentialOpen(true);
      setRotateTarget(null);
      qc.invalidateQueries({ queryKey: ["clients", workspaceId] });
    },
    onError: (e) => toast.error(`Rotate failed: ${(e as Error).message}`),
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => api.revokeClient(id),
    onSuccess: () => {
      toast.success("Client revoked");
      setRevokeTarget(null);
      qc.invalidateQueries({ queryKey: ["clients", workspaceId] });
    },
    onError: (e) => toast.error(`Revoke failed: ${(e as Error).message}`),
  });
  const deleteGrantM = useMutation({
    mutationFn: (id: string) => api.deleteGrant(id),
    onSuccess: () => {
      toast.success("Grant removed");
      qc.invalidateQueries({ queryKey: ["grants", workspaceId] });
    },
    onError: (e) => toast.error(`Remove failed: ${(e as Error).message}`),
  });
  const createGrantM = useMutation({
    mutationFn: api.createGrant,
    onSuccess: () => {
      toast.success("Grant added");
      qc.invalidateQueries({ queryKey: ["grants", workspaceId] });
    },
    onError: (e) => toast.error(`Add grant failed: ${(e as Error).message}`),
  });

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — service clients list may be empty.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Service Clients</h1>
          <p className="text-xs text-zinc-500">
            Identities that consume secrets. Credentials are stored as digests
            only; reveal happens once at creation or rotation.
          </p>
        </div>
        <Button
          onClick={() => setNewOpen(true)}
          disabled={forbidden}
          className="min-h-11 bg-emerald-600 text-white hover:bg-emerald-500"
        >
          <Plus className="size-4" />
          New Client
        </Button>
      </div>

      {forbidden ? (
        <ForbiddenState />
      ) : (
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <Table className="vault-table">
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-zinc-400">Name</TableHead>
              <TableHead className="text-zinc-400">Type</TableHead>
              <TableHead className="text-zinc-400">Public ID</TableHead>
              <TableHead className="text-zinc-400">Status</TableHead>
              <TableHead className="text-zinc-400">Expires</TableHead>
              <TableHead className="text-zinc-400">Last Used</TableHead>
              <TableHead className="text-zinc-400 text-right">Grants</TableHead>
              <TableHead className="w-10 text-zinc-400" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {clientsQ.isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i} className="border-zinc-800">
                  <TableCell colSpan={8}>
                    <Skeleton className="h-7 w-full bg-zinc-800/60" />
                  </TableCell>
                </TableRow>
              ))
            ) : clients.length === 0 ? (
              <TableRow className="border-zinc-800">
                <TableCell colSpan={8}>
                  <EmptyState
                    icon={Bot}
                    title="No service clients"
                    hint="Create a new client to obtain a one-time credential. The seed creates several demo clients."
                  />
                </TableCell>
              </TableRow>
            ) : (
              clients.map((c) => (
                <TableRow
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={cn(
                    "cursor-pointer border-zinc-800 hover:bg-zinc-800/40",
                    "[&>td:first-child]:sticky [&>td:first-child]:left-0 [&>td:first-child]:bg-zinc-950/95 [&>td:first-child]:z-10",
                  )}
                >
                  <TableCell className="text-sm text-zinc-200">{c.name}</TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="border-zinc-700 bg-zinc-800/40 font-mono text-[10px] text-zinc-300"
                    >
                      {c.clientType}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <span className="font-mono text-[11px] text-zinc-400">
                        {c.credentialPrefix}…
                      </span>
                      <CopyButton
                        text={c.publicId}
                        toastLabel="Public ID copied"
                        size="icon"
                        variant="ghost"
                      />
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={c.status} />
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400">
                    <RelativeTime value={c.expiresAt} fallback="never" warnWithinHours={24} />
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400">
                    <RelativeTime value={c.lastUsedAt} fallback="never" />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-zinc-300">
                    {c.grantsCount ?? 0}
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${c.name}`}
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
                          onSelect={() => setRotateTarget(c)}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <RefreshCw className="size-3.5 text-amber-400" />
                          Rotate Credential
                        </DropdownMenuItem>
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
      )}

      {/* New Client */}
      <NewClientDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        workspaces={workspacesQ.data?.workspaces ?? []}
        defaultWorkspaceId={workspaceId}
        pending={createM.isPending}
        onSubmit={(input) => createM.mutate(input)}
      />

      {/* Credential one-time reveal */}
      <Dialog open={credentialOpen} onOpenChange={(o) => {
        setCredentialOpen(o);
        if (!o) {
          setCredentialResult(null);
          setCredentialClientName("");
        }
      }}>
        <DialogContent className="border-amber-700/50 bg-zinc-900 text-zinc-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-200">
              <RefreshCw className="size-4 text-amber-400" />
              Credential for{" "}
              <span className="font-mono text-sm text-zinc-200">
                {credentialClientName}
              </span>
            </DialogTitle>
            <DialogDescription className="text-rose-300 font-semibold">
              You will NOT see this credential again. Copy it now and store it
              securely — only a SHA-256 digest is persisted.
            </DialogDescription>
          </DialogHeader>
          {credentialResult ? (
            <SecretValueReveal
              value={credentialResult}
              label="vlt_live_…  credential"
              autoFocusReveal
              notice="Cache-Control: no-store · digest-only persisted · copy once"
            />
          ) : (
            <Skeleton className="h-12 w-full bg-zinc-800" />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCredentialOpen(false);
                setCredentialResult(null);
              }}
              className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
            >
              Close & forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title="Revoke service client?"
        description={
          revokeTarget ? (
            <>
              Revoking{" "}
              <span className="font-mono text-zinc-200">{revokeTarget.name}</span>{" "}
              permanently disables its credential. Existing grants remain on
              record but cannot be exercised.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Revoke"
        destructive
        onConfirm={() => revokeTarget && revokeM.mutate(revokeTarget.id)}
      />

      {/* Rotate confirm */}
      <ConfirmDialog
        open={!!rotateTarget}
        onOpenChange={(o) => !o && setRotateTarget(null)}
        title="Rotate credential?"
        description={
          rotateTarget ? (
            <>
              A new credential is minted for{" "}
              <span className="font-mono text-zinc-200">
                {rotateTarget.name}
              </span>
              . The old digest is replaced. The new credential is shown ONCE in
              the next dialog.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Rotate"
        destructive={false}
        onConfirm={() => rotateTarget && rotateCredM.mutate(rotateTarget.id)}
      />

      {/* Detail Sheet */}
      <Sheet
        open={!!selectedId}
        onOpenChange={(o) => !o && setSelectedId(null)}
      >
        <SheetContent
          side="right"
          className="border-l border-zinc-800 bg-zinc-950 p-0 text-zinc-100 sm:max-w-md"
        >
          <SheetHeader className="border-b border-zinc-800">
            <SheetTitle className="text-sm text-zinc-200">
              {selectedClient?.name ?? "Service client"}
            </SheetTitle>
            <SheetDescription className="text-xs text-zinc-500">
              Grants &mdash; edit which secrets this client can access.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {!selectedClient ? (
              <Skeleton className="h-32 w-full bg-zinc-800" />
            ) : (
              <ClientGrantsEditor
                client={selectedClient}
                grants={clientGrants}
                secrets={secretsQ.data?.secrets ?? []}
                onRemove={(id) => deleteGrantM.mutate(id)}
                onAdd={(input) => createGrantM.mutate(input)}
                pending={createGrantM.isPending || deleteGrantM.isPending}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ClientGrantsEditor({
  client,
  grants,
  secrets,
  onRemove,
  onAdd,
  pending,
}: {
  client: ClientListItem;
  grants: {
    id: string;
    vaultSecretId: string;
    secretPath: string;
    secretName: string;
    permissions: string;
  }[];
  secrets: { id: string; path: string; name: string }[];
  onRemove: (id: string) => void;
  onAdd: (input: {
    serviceClientId: string;
    vaultSecretId: string;
    permissions: string;
  }) => void;
  pending: boolean;
}) {
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
    <div className="space-y-4">
      <div>
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Existing grants
        </h3>
        {grants.length === 0 ? (
          <div className="text-xs text-zinc-500">
            No grants yet — this client can do nothing until granted.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {grants.map((g) => (
              <li
                key={g.id}
                className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-mono text-zinc-200">
                    {g.secretPath}
                  </div>
                  <div className="text-[10px] text-zinc-500">
                    {g.permissions}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove grant for ${g.secretPath}`}
                  onClick={() => onRemove(g.id)}
                  disabled={pending}
                  className="size-8 text-rose-300 hover:bg-rose-900/30 hover:text-rose-200"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
        <h3 className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
          Add grant
        </h3>
        <div className="space-y-2">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Secret
            </Label>
            <Select value={secretId} onValueChange={setSecretId}>
              <SelectTrigger className="text-xs">
                <SelectValue placeholder="Choose a secret" />
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
          <Button
            size="sm"
            disabled={pending || !secretId || perms.size === 0}
            onClick={() =>
              onAdd({
                serviceClientId: client.id,
                vaultSecretId: secretId,
                permissions: Array.from(perms).join(","),
              })
            }
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            <Plus className="size-3.5" />
            Add grant
          </Button>
        </div>
      </div>
    </div>
  );
}

function NewClientDialog({
  open,
  onOpenChange,
  workspaces,
  defaultWorkspaceId,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaces: { id: string; slug: string; name: string }[];
  defaultWorkspaceId: string;
  pending: boolean;
  onSubmit: (input: {
    name: string;
    clientType: string;
    workspaceId: string;
    expiresInDays?: number;
  }) => void;
}) {
  const [name, setName] = useState("");
  const [clientType, setClientType] = useState<string>("bot");
  const [wsId, setWsId] = useState<string>(defaultWorkspaceId || "");
  const [expiresInDays, setExpiresInDays] = useState<number | "">("");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">New Service Client</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Create an identity and obtain a one-time credential. The credential
            is returned ONCE — only its SHA-256 digest is stored.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Name
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="text-xs"
              placeholder="algo-scalper-bot"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
                Type
              </Label>
              <Select value={clientType} onValueChange={setClientType}>
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {CLIENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t} className="font-mono">
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
                Workspace
              </Label>
              <Select
                value={wsId || undefined}
                onValueChange={setWsId}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue placeholder="Choose workspace" />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      <span className="font-mono">{w.slug}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
              Expires in (days, optional)
            </Label>
            <Input
              type="number"
              value={expiresInDays}
              onChange={(e) =>
                setExpiresInDays(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className="text-xs"
              placeholder="leave blank for no expiry"
            />
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
            disabled={pending || !name || !wsId}
            onClick={() =>
              onSubmit({
                name,
                clientType,
                workspaceId: wsId,
                expiresInDays:
                  expiresInDays === "" ? undefined : Number(expiresInDays),
              })
            }
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {pending ? "Minting…" : "Create & reveal credential"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
