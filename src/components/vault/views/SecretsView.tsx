"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  Eye,
  EyeOff,
  GitCompareArrows,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCw,
  Share2,
  ShieldAlert,
  Trash2,
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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
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
import type {
  AuditEventListItem,
  Classification,
  SecretKind,
  SecretListItem,
  SecretUsageResponse,
} from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge, statusTone, type StatusTone } from "../StatusBadge";
import { RelativeTime, AbsoluteTime } from "../RelativeTime";
import { ConfirmDialog } from "../ConfirmDialog";
import { SecretValueReveal } from "../SecretValueReveal";
import { CopyButton } from "../CopyButton";
import { EmptyState, isApiWarmingError } from "../Status";
import { cn } from "@/lib/utils";

// Lazy-load the diff dialog so its Select/Badge/Skeleton deps only compile
// when the user opens it — keeps view compilation memory low.
import dynamic from "next/dynamic";
const SecretDiffDialogLazy = dynamic(
  () =>
    import("../SecretDiffDialog").then((m) => m.SecretDiffDialog),
  { ssr: false, loading: () => null },
);

const KINDS: SecretKind[] = [
  "api_key",
  "access_token",
  "refresh_token",
  "client_secret",
  "totp_seed",
  "private_key",
  "certificate",
  "connection_string",
  "public_key",
];
const CLASSIFICATIONS: Classification[] = [
  "public",
  "internal",
  "confidential",
  "restricted",
];

export function SecretsView() {
  const workspaceId = useVaultStore((s) => s.workspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newSecretOpen, setNewSecretOpen] = useState(false);
  const [revealTarget, setRevealTarget] = useState<SecretListItem | null>(null);
  const [revealOpen, setRevealOpen] = useState(false);
  const [confirmReveal, setConfirmReveal] = useState(false);
  const [revealValue, setRevealValue] = useState<string | null>(null);
  const [newVersionTarget, setNewVersionTarget] =
    useState<SecretListItem | null>(null);
  const [rotateTarget, setRotateTarget] = useState<SecretListItem | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<SecretListItem | null>(null);
  const [diffTarget, setDiffTarget] = useState<SecretListItem | null>(null);
  // R8: active tab in the secret detail Sheet. Controlled so the Usage tab can
  // gate its query (`api.secretUsage`) until the user opens it — avoids
  // hitting the backend for every secret the operator inspects.
  const [detailTab, setDetailTab] = useState<
    "versions" | "grants" | "activity" | "usage"
  >("versions");

  const secretsQ = useQuery({
    queryKey: ["secrets", workspaceId, refreshTick],
    queryFn: () => api.listSecrets(workspaceId),
    enabled: !!workspaceId,
  });

  const detailQ = useQuery({
    queryKey: ["secret", selectedId, refreshTick],
    queryFn: () => api.getSecret(selectedId!),
    enabled: !!selectedId,
  });
  const versionsQ = useQuery({
    queryKey: ["secret-versions", selectedId, refreshTick],
    queryFn: () => api.listVersions(selectedId!),
    enabled: !!selectedId,
  });
  const grantsQ = useQuery({
    queryKey: ["grants", workspaceId, refreshTick],
    queryFn: () => api.listGrants(workspaceId),
    enabled: !!workspaceId,
  });
  const eventsQ = useQuery({
    queryKey: ["secret-events", selectedId, refreshTick],
    queryFn: () => api.listSecretEvents(selectedId!, 50),
    enabled: !!selectedId,
  });
  // R8: secret usage / blast radius — only fetched when the operator opens the
  // "Usage" tab. Answers "what breaks if this secret is revoked?". Lazy to keep
  // the per-row Sheet open cost low.
  const usageQ = useQuery({
    queryKey: ["secret-usage", selectedId, refreshTick],
    queryFn: () => api.secretUsage(selectedId!),
    enabled: !!selectedId && detailTab === "usage",
  });

  const warming = secretsQ.isError && isApiWarmingError(secretsQ.error);

  const secrets = useMemo(() => {
    const list = secretsQ.data?.secrets ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((s) => {
      if (q && !`${s.path} ${s.name}`.toLowerCase().includes(q)) return false;
      if (kindFilter !== "all" && s.kind !== kindFilter) return false;
      if (statusFilter !== "all" && s.status !== statusFilter) return false;
      return true;
    });
  }, [secretsQ.data, search, kindFilter, statusFilter]);

  const secretGrants = useMemo(() => {
    if (!selectedId) return [];
    return (grantsQ.data?.grants ?? []).filter(
      (g) => g.vaultSecretId === selectedId,
    );
  }, [grantsQ.data, selectedId]);

  // Mutations
  const createSecretM = useMutation({
    mutationFn: api.createSecret,
    onSuccess: () => {
      toast.success("Secret created");
      setNewSecretOpen(false);
      qc.invalidateQueries({ queryKey: ["secrets", workspaceId] });
    },
    onError: (e) => toast.error(`Create failed: ${(e as Error).message}`),
  });
  const revealM = useMutation({
    mutationFn: (id: string) => api.revealSecret(id, "dashboard reveal"),
    onSuccess: (res) => {
      setRevealValue(res.value);
      setConfirmReveal(false);
      setRevealOpen(true);
    },
    onError: (e) => {
      toast.error(`Reveal failed: ${(e as Error).message}`);
      setConfirmReveal(false);
    },
  });
  const newVersionM = useMutation({
    mutationFn: (input: { id: string; value: string; expiresInHours?: number }) =>
      api.createVersion(input.id, {
        value: input.value,
        expiresInHours: input.expiresInHours,
      }),
    onSuccess: () => {
      toast.success("New version created");
      setNewVersionTarget(null);
      qc.invalidateQueries({ queryKey: ["secret-versions", selectedId] });
      qc.invalidateQueries({ queryKey: ["secrets", workspaceId] });
    },
    onError: (e) => toast.error(`Version create failed: ${(e as Error).message}`),
  });
  const rotateM = useMutation({
    mutationFn: (input: { id: string; expiresInHours?: number }) =>
      api.rotateSecret(input.id, { expiresInHours: input.expiresInHours }),
    onSuccess: () => {
      toast.success("Secret rotated");
      setRotateTarget(null);
      qc.invalidateQueries({ queryKey: ["secret-versions", selectedId] });
      qc.invalidateQueries({ queryKey: ["secrets", workspaceId] });
    },
    onError: (e) => toast.error(`Rotate failed: ${(e as Error).message}`),
  });
  const revokeM = useMutation({
    mutationFn: (id: string) => api.revokeSecret(id, false),
    onSuccess: () => {
      toast.success("Secret revoked");
      setRevokeTarget(null);
      qc.invalidateQueries({ queryKey: ["secrets", workspaceId] });
    },
    onError: (e) => toast.error(`Revoke failed: ${(e as Error).message}`),
  });

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — secrets may be empty. Create actions may fail
          until the API is ready.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Secrets</h1>
          <p className="text-xs text-zinc-500">
            Workspace-isolated, versioned, envelope-encrypted secret store.
          </p>
        </div>
        <Button
          onClick={() => setNewSecretOpen(true)}
          className="min-h-11 bg-emerald-600 text-white hover:bg-emerald-500"
        >
          <Plus className="size-4" />
          New Secret
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Search by path or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 max-w-xs border-zinc-800 bg-zinc-900/60 text-sm text-zinc-200 placeholder:text-zinc-600"
          aria-label="Search secrets"
        />
        <Select value={kindFilter} onValueChange={setKindFilter}>
          <SelectTrigger
            className="h-9 w-[140px] min-h-9 border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200"
            aria-label="Filter by kind"
          >
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
            <SelectItem value="all">All kinds</SelectItem>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k} className="font-mono">
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger
            className="h-9 w-[140px] min-h-9 border-zinc-800 bg-zinc-900/60 text-xs text-zinc-200"
            aria-label="Filter by status"
          >
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
            <SelectItem value="all">All statuses</SelectItem>
            {["active", "rotating", "revoked", "expired", "retired"].map((s) => (
              <SelectItem key={s} value={s} className="font-mono">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto text-xs text-zinc-500">
          {secrets.length} of {secretsQ.data?.secrets?.length ?? 0}
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
        <Table className="vault-table">
          <TableHeader>
            <TableRow className="border-zinc-800 hover:bg-transparent">
              <TableHead className="text-zinc-400">Path</TableHead>
              <TableHead className="text-zinc-400">Kind</TableHead>
              <TableHead className="text-zinc-400">Class</TableHead>
              <TableHead className="text-zinc-400">Env</TableHead>
              <TableHead className="text-zinc-400">Status</TableHead>
              <TableHead className="text-zinc-400">Expires</TableHead>
              <TableHead className="text-zinc-400 text-right">Versions</TableHead>
              <TableHead className="text-zinc-400">Updated</TableHead>
              <TableHead className="w-10 text-zinc-400" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {secretsQ.isLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <TableRow key={i} className="border-zinc-800">
                  <TableCell colSpan={9}>
                    <Skeleton className="h-7 w-full bg-zinc-800/60" />
                  </TableCell>
                </TableRow>
              ))
            ) : secrets.length === 0 ? (
              <TableRow className="border-zinc-800">
                <TableCell colSpan={9}>
                  <EmptyState
                    icon={KeyRound}
                    title="No secrets found"
                    hint="Adjust filters or seed the vault from the dashboard. New secrets you create will appear here."
                  />
                </TableCell>
              </TableRow>
            ) : (
              secrets.map((s) => (
                <TableRow
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  className={cn(
                    "cursor-pointer border-zinc-800 hover:bg-zinc-800/40",
                    "[&>td:first-child]:sticky [&>td:first-child]:left-0 [&>td:first-child]:bg-zinc-950/95 [&>td:first-child]:z-10",
                  )}
                >
                  <TableCell className="font-mono text-xs text-zinc-200">
                    {s.path}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant="outline"
                      className="border-zinc-700 bg-zinc-800/40 font-mono text-[10px] text-zinc-300"
                    >
                      {s.kind}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.classification} />
                  </TableCell>
                  <TableCell className="font-mono text-[11px] text-zinc-400">
                    {s.environment}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400">
                    <RelativeTime value={s.expiresAt} warnWithinHours={24} />
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-zinc-300">
                    {s.versionCount}
                  </TableCell>
                  <TableCell className="text-xs text-zinc-400">
                    <RelativeTime value={s.updatedAt} />
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Actions for ${s.path}`}
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
                            setRevealTarget(s);
                            setConfirmReveal(true);
                          }}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <Eye className="size-3.5 text-emerald-400" />
                          Reveal
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setNewVersionTarget(s)}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <Plus className="size-3.5 text-zinc-300" />
                          New Version
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setRotateTarget(s)}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <RotateCw className="size-3.5 text-amber-400" />
                          Rotate
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onSelect={() => setDiffTarget(s)}
                          className="hover:bg-zinc-800 focus:bg-zinc-800"
                        >
                          <GitCompareArrows className="size-3.5 text-sky-400" />
                          Compare Versions
                        </DropdownMenuItem>
                        <DropdownMenuSeparator className="bg-zinc-800" />
                        <DropdownMenuItem
                          onSelect={() => setRevokeTarget(s)}
                          className="text-rose-300 hover:bg-rose-900/30 focus:bg-rose-900/30"
                        >
                          <Trash2 className="size-3.5" />
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

      {/* New Secret Dialog */}
      <NewSecretDialog
        open={newSecretOpen}
        onOpenChange={setNewSecretOpen}
        workspaceId={workspaceId}
        pending={createSecretM.isPending}
        onSubmit={(input) => createSecretM.mutate(input)}
      />

      {/* Reveal Confirm */}
      <ConfirmDialog
        open={confirmReveal}
        onOpenChange={(o) => {
          setConfirmReveal(o);
          if (!o) setRevealTarget(null);
        }}
        title="Reveal plaintext secret?"
        description={
          revealTarget ? (
            <>
              This decrypts the active version of{" "}
              <span className="font-mono text-zinc-200">
                {revealTarget.path}
              </span>{" "}
              and returns the plaintext to your browser. The response is marked{" "}
              <span className="font-mono">Cache-Control: no-store</span> and the
              value is never logged. Continue?
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Reveal"
        destructive={false}
        onConfirm={() => {
          if (revealTarget) revealM.mutate(revealTarget.id);
        }}
      />

      {/* Reveal Result */}
      <Dialog open={revealOpen} onOpenChange={(o) => {
        setRevealOpen(o);
        if (!o) {
          setRevealValue(null);
          setRevealTarget(null);
        }
      }}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-zinc-100">
              <Eye className="size-4 text-emerald-400" />
              Revealed:{" "}
              <span className="font-mono text-sm text-zinc-300">
                {revealTarget?.path}
              </span>
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              Active version plaintext for this secret. Copy it now — the panel
              will not retain the value after closing.
            </DialogDescription>
          </DialogHeader>
          {revealValue ? (
            <SecretValueReveal value={revealValue} autoFocusReveal />
          ) : (
            <Skeleton className="h-12 w-full bg-zinc-800" />
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setRevealOpen(false);
                setRevealValue(null);
                setRevealTarget(null);
              }}
              className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
            >
              <X className="size-3.5" />
              Close & forget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New Version Dialog */}
      <NewVersionDialog
        secret={newVersionTarget}
        onOpenChange={(o) => !o && setNewVersionTarget(null)}
        pending={newVersionM.isPending}
        onSubmit={(value, expiresInHours) =>
          newVersionTarget &&
          newVersionM.mutate({ id: newVersionTarget.id, value, expiresInHours })
        }
      />

      {/* Rotate Dialog */}
      <RotateDialog
        secret={rotateTarget}
        onOpenChange={(o) => !o && setRotateTarget(null)}
        pending={rotateM.isPending}
        onSubmit={(expiresInHours) =>
          rotateTarget &&
          rotateM.mutate({ id: rotateTarget.id, expiresInHours })
        }
      />

      {/* Revoke Confirm */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => !o && setRevokeTarget(null)}
        title="Revoke secret?"
        description={
          revokeTarget ? (
            <>
              Revoking{" "}
              <span className="font-mono text-zinc-200">
                {revokeTarget.path}
              </span>{" "}
              marks the secret and its current active version as revoked. New
              access will be denied. This is reversible only by creating a new
              version.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Revoke"
        destructive
        onConfirm={() => revokeTarget && revokeM.mutate(revokeTarget.id)}
      />

      {/* Version Diff Dialog */}
      {diffTarget && (
        <SecretDiffDialogLazy
          secretId={diffTarget.id}
          secretPath={diffTarget.path}
          open={!!diffTarget}
          onOpenChange={(o) => !o && setDiffTarget(null)}
        />
      )}

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
            <SheetTitle className="font-mono text-sm text-zinc-200">
              {detailQ.data?.secret?.path ?? "Secret detail"}
            </SheetTitle>
            <SheetDescription className="text-xs text-zinc-500">
              Version history, grants, activity timeline, and downstream
              usage / blast radius for this secret.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
            {detailQ.isLoading || !detailQ.data ? (
              <div className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full bg-zinc-800" />
                ))}
              </div>
            ) : (
              <>
                <div className="mb-4 grid grid-cols-2 gap-2 text-xs">
                  <Detail label="Kind" value={detailQ.data.secret.kind} mono />
                  <Detail
                    label="Classification"
                    value={detailQ.data.secret.classification}
                  />
                  <Detail
                    label="Environment"
                    value={detailQ.data.secret.environment}
                    mono
                  />
                  <Detail
                    label="Provider"
                    value={detailQ.data.secret.provider ?? "—"}
                    mono
                  />
                  <Detail
                    label="Status"
                    value={<StatusBadge status={detailQ.data.secret.status} />}
                  />
                  <Detail
                    label="Versions"
                    value={detailQ.data.secret.versions?.length ?? 0}
                    mono
                  />
                </div>

                <Tabs
                  value={detailTab}
                  onValueChange={(v) =>
                    setDetailTab(
                      v as "versions" | "grants" | "activity" | "usage",
                    )
                  }
                  className="w-full"
                >
                  <TabsList className="grid w-full grid-cols-4 border-zinc-800 bg-zinc-900/60">
                    <TabsTrigger
                      value="versions"
                      className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-[11px]"
                    >
                      Versions
                    </TabsTrigger>
                    <TabsTrigger
                      value="grants"
                      className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-[11px]"
                    >
                      Grants ({secretGrants.length})
                    </TabsTrigger>
                    <TabsTrigger
                      value="activity"
                      className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-[11px]"
                    >
                      Activity
                    </TabsTrigger>
                    <TabsTrigger
                      value="usage"
                      className="data-[state=active]:bg-zinc-800 data-[state=active]:text-zinc-100 text-[11px]"
                    >
                      <Share2 className="size-3" />
                      Usage
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="versions" className="mt-3">
                    {versionsQ.isLoading ? (
                      <Skeleton className="h-32 w-full bg-zinc-800" />
                    ) : (versionsQ.data?.versions ?? []).length === 0 ? (
                      <div className="text-xs text-zinc-500">No versions.</div>
                    ) : (
                      <ul className="space-y-2">
                        {(versionsQ.data?.versions ?? []).map((v) => (
                          <li
                            key={v.id}
                            className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-xs text-zinc-200">
                                v{v.versionNumber}
                              </span>
                              <StatusBadge status={v.status} />
                            </div>
                            <div className="mt-1 text-[11px] text-zinc-500">
                              <div>
                                created by{" "}
                                <span className="font-mono text-zinc-400">
                                  {v.createdBy}
                                </span>
                              </div>
                              <div>
                                activated <RelativeTime value={v.activatedAt} />
                              </div>
                              {v.retiredAt && (
                                <div>
                                  retired <RelativeTime value={v.retiredAt} />
                                </div>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TabsContent>

                  <TabsContent value="grants" className="mt-3">
                    {secretGrants.length === 0 ? (
                      <div className="text-xs text-zinc-500">
                        No explicit grants for this secret. Admin access
                        applies.
                      </div>
                    ) : (
                      <ul className="space-y-1.5">
                        {secretGrants.map((g) => (
                          <li
                            key={g.id}
                            className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-mono text-zinc-200">
                                {g.serviceClientName}
                              </div>
                              <div className="text-[10px] text-zinc-500">
                                {g.permissions}
                              </div>
                            </div>
                            <CopyButton
                              text={g.id}
                              toastLabel="Grant ID copied"
                              size="icon"
                              variant="ghost"
                            />
                          </li>
                        ))}
                      </ul>
                    )}
                  </TabsContent>

                  <TabsContent value="activity" className="mt-3">
                    <ActivityTimeline
                      events={eventsQ.data?.events ?? []}
                      loading={eventsQ.isLoading}
                    />
                  </TabsContent>

                  <TabsContent value="usage" className="mt-3">
                    <SecretUsagePanel
                      data={usageQ.data}
                      loading={usageQ.isLoading}
                      secretPath={detailQ.data?.secret?.path}
                    />
                  </TabsContent>
                </Tabs>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
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

const EVENT_TONE_CLASSES: Record<StatusTone, string> = {
  emerald: "border-emerald-700/40 bg-emerald-500/10 text-emerald-300",
  amber: "border-amber-700/40 bg-amber-500/10 text-amber-300",
  rose: "border-rose-700/40 bg-rose-500/10 text-rose-300",
  zinc: "border-zinc-700/60 bg-zinc-500/10 text-zinc-300",
  teal: "border-teal-700/40 bg-teal-500/10 text-teal-300",
  sky: "border-sky-700/40 bg-sky-500/10 text-sky-300",
  violet: "border-violet-700/40 bg-violet-500/10 text-violet-300",
};

const EVENT_DOT_CLASS: Record<StatusTone, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  zinc: "bg-zinc-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  violet: "bg-violet-500",
};

/**
 * Vertical timeline of audit events for a single secret. Answers
 * "what happened to this secret?" — reveals, rotates, lease issues/revokes,
 * refreshes, etc. The data is value-free (audit records contain metadata
 * only — never the secret itself).
 */
function ActivityTimeline({
  events,
  loading,
}: {
  events: AuditEventListItem[];
  loading: boolean;
}) {
  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full bg-zinc-800" />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-3 py-8 text-center">
        <Activity className="size-5 text-zinc-600" />
        <div className="text-xs text-zinc-400">No activity recorded yet</div>
        <div className="text-[10px] text-zinc-600 max-w-xs">
          Reveals, rotations, lease issues/revokes, and refresh events for
          this secret will appear here. Audit records are value-free.
        </div>
      </div>
    );
  }
  return (
    <ol className="relative ml-3 border-l border-zinc-800 pl-4">
      {events.map((e) => {
        const tone = statusTone(e.outcome);
        const actor = e.actorClientName ?? "system";
        return (
          <li key={e.id} className="relative mb-3 last:mb-0">
            <span
              className={cn(
                "absolute -left-[21px] top-1 size-2.5 rounded-full ring-2 ring-zinc-950",
                EVENT_DOT_CLASS[tone],
              )}
              aria-hidden
            />
            <div className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={cn(
                    "border font-mono text-[9px]",
                    EVENT_TONE_CLASSES[tone],
                  )}
                >
                  {e.action}
                </Badge>
                <StatusBadge status={e.outcome} />
                <span className="ml-auto text-[10px] text-zinc-500">
                  <RelativeTime value={e.createdAt} />
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                <span className="font-mono text-zinc-400">{actor}</span>
                {e.reasonCode && (
                  <span className="font-mono text-amber-300">
                    · {e.reasonCode}
                  </span>
                )}
                {e.requestId && (
                  <span className="font-mono text-zinc-600 truncate max-w-[120px]">
                    · req {e.requestId.slice(0, 8)}…
                  </span>
                )}
              </div>
              <div className="mt-0.5 text-[10px] text-zinc-600">
                <AbsoluteTime value={e.createdAt} />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * R8: Secret Usage / Blast Radius panel — the 4th tab in the secret detail
 * Sheet. Answers "what breaks if this secret is revoked?": a blast-radius
 * summary (clients / connections / active leases) at the top, followed by
 * three downstream-dependency lists (grants, connection bindings, leases).
 *
 * Lazy-loaded: the parent query is only fired when the operator opens the
 * "Usage" tab, so merely opening the Sheet for a quick version check doesn't
 * hit the usage endpoint. Skeletons while fetching. Empty-state copy is
 * intentional and row-specific (grants vs connections vs leases).
 */
function SecretUsagePanel({
  data,
  loading,
  secretPath,
}: {
  data: SecretUsageResponse | undefined;
  loading: boolean;
  secretPath?: string;
}) {
  if (loading || !data) {
    return (
      <div className="space-y-2">
        {/* blast-radius pills skeleton */}
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-14 w-full bg-zinc-800/60" />
          ))}
        </div>
        {/* downstream dependencies skeleton */}
        <Skeleton className="h-8 w-32 bg-zinc-800/60" />
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full bg-zinc-800/60" />
        ))}
      </div>
    );
  }

  const { blastRadius, usage } = data;
  const totalConsumers =
    blastRadius.clientCount + blastRadius.connectionCount;

  return (
    <div className="space-y-3">
      {/* ---- Blast Radius summary ---- */}
      <div className="vault-card rounded-md border border-zinc-800 bg-zinc-900/40 p-3">
        <div className="mb-2 flex items-center gap-2">
          <ShieldAlert className="size-4 text-amber-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-300">
            Blast Radius
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {/* clients */}
          <div className="rounded-md border border-emerald-700/30 bg-emerald-500/10 px-2 py-2 text-center">
            <div className="flex items-center justify-center gap-1 text-emerald-400">
              <KeyRound className="size-3" />
              <span className="font-mono text-lg font-bold tabular-nums">
                {blastRadius.clientCount}
              </span>
            </div>
            <div className="text-[9px] uppercase tracking-wide text-emerald-300/70">
              clients
            </div>
          </div>
          {/* connections */}
          <div className="rounded-md border border-teal-700/30 bg-teal-500/10 px-2 py-2 text-center">
            <div className="flex items-center justify-center gap-1 text-teal-400">
              <Share2 className="size-3" />
              <span className="font-mono text-lg font-bold tabular-nums">
                {blastRadius.connectionCount}
              </span>
            </div>
            <div className="text-[9px] uppercase tracking-wide text-teal-300/70">
              connections
            </div>
          </div>
          {/* active leases */}
          <div className="rounded-md border border-amber-700/30 bg-amber-500/10 px-2 py-2 text-center">
            <div className="flex items-center justify-center gap-1 text-amber-400">
              <Activity className="size-3" />
              <span className="font-mono text-lg font-bold tabular-nums">
                {blastRadius.activeLeaseCount}
              </span>
            </div>
            <div className="text-[9px] uppercase tracking-wide text-amber-300/70">
              active leases
            </div>
          </div>
        </div>
        <div className="mt-2 text-[10px] text-zinc-400">
          {totalConsumers > 0 ? (
            <>
              If{" "}
              <span className="font-mono text-zinc-300">
                {secretPath ?? "this secret"}
              </span>{" "}
              is revoked,{" "}
              <span className="font-semibold text-amber-300">
                {totalConsumers} consumer{totalConsumers === 1 ? "" : "s"}
              </span>{" "}
              will lose access.
            </>
          ) : (
            <>
              No consumers depend on this secret — revocation is safe.
            </>
          )}
        </div>
      </div>

      {/* ---- Downstream Dependencies: Grants ---- */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          <KeyRound className="size-3 text-emerald-400" />
          Grants
          <span className="font-mono text-zinc-500">
            ({usage.grants.length})
          </span>
        </div>
        {usage.grants.length === 0 ? (
          <div className="vault-empty-state text-[10px] text-zinc-500">
            No clients have direct grants.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {usage.grants.map((g) => (
              <li
                key={g.clientId}
                className="vault-card rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[11px] text-zinc-200">
                        {g.clientName}
                      </span>
                      <span className="rounded border border-zinc-700 bg-zinc-800/40 px-1 font-mono text-[9px] uppercase text-zinc-400">
                        {g.clientType}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {g.permissions.map((p) => (
                        <span
                          key={p}
                          className="rounded border border-emerald-700/30 bg-emerald-500/10 px-1 py-0.5 font-mono text-[9px] text-emerald-300"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="shrink-0 whitespace-nowrap text-[10px] text-zinc-500">
                    used <RelativeTime value={g.lastUsedAt} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Downstream Dependencies: Connections ---- */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          <Share2 className="size-3 text-teal-400" />
          Connections
          <span className="font-mono text-zinc-500">
            ({usage.connections.length})
          </span>
        </div>
        {usage.connections.length === 0 ? (
          <div className="vault-empty-state text-[10px] text-zinc-500">
            Not bound to any connections.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {usage.connections.map((c) => (
              <li
                key={c.connectionId}
                className="vault-card rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-zinc-200">
                      {c.providerKey}/{c.adapterKey}
                    </div>
                    <div className="mt-0.5 truncate text-[10px] text-zinc-500">
                      <span className="font-mono text-teal-300/80">
                        {c.purpose}
                      </span>
                      {c.providerAccountRef && (
                        <>
                          <span className="text-zinc-600"> · </span>
                          <span className="font-mono text-zinc-400">
                            {c.providerAccountRef}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <StatusBadge
                    status={c.status}
                    className="shrink-0 self-center"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ---- Downstream Dependencies: Leases ---- */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
          <Activity className="size-3 text-amber-400" />
          Leases
          <span className="font-mono text-zinc-500">
            ({usage.leases.length})
          </span>
        </div>
        {usage.leases.length === 0 ? (
          <div className="vault-empty-state text-[10px] text-zinc-500">
            No active leases.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {usage.leases.map((l) => (
              <li
                key={l.leaseId}
                className="vault-card rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] text-zinc-200">
                      {l.clientName}
                    </div>
                    <div className="mt-0.5 text-[10px] text-zinc-500">
                      expires{" "}
                      <RelativeTime
                        value={l.expiresAt}
                        warnWithinHours={5 / 60}
                      />
                    </div>
                  </div>
                  <StatusBadge
                    status={l.status}
                    className="shrink-0 self-center"
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function NewSecretDialog({
  open,
  onOpenChange,
  workspaceId,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
  pending: boolean;
  onSubmit: (input: {
    workspaceId: string;
    path: string;
    name: string;
    kind: string;
    classification?: string;
    environment?: string;
    provider?: string;
    value: string;
    expiresInHours?: number;
  }) => void;
}) {
  const [path, setPath] = useState("db/prod/connection-string");
  const [name, setName] = useState("database connection string");
  const [kind, setKind] = useState<string>("connection_string");
  const [classification, setClassification] = useState<string>("restricted");
  const [environment, setEnvironment] = useState("production");
  const [provider, setProvider] = useState("");
  const [value, setValue] = useState("");
  const [expiresInHours, setExpiresInHours] = useState<number | "">("");

  function submit() {
    onSubmit({
      workspaceId,
      path,
      name,
      kind,
      classification,
      environment,
      provider: provider || undefined,
      value,
      expiresInHours: expiresInHours === "" ? undefined : Number(expiresInHours),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">New Secret</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Creates a new secret with its first encrypted version. The plaintext
            is wrapped via AES-256-GCM envelope encryption before storage.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Path">
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                className="font-mono text-xs"
                placeholder="db/prod/connection-string"
              />
            </Field>
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-xs"
              />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind">
              <Select value={kind} onValueChange={setKind}>
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="font-mono">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Classification">
              <Select
                value={classification}
                onValueChange={setClassification}
              >
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900">
                  {CLASSIFICATIONS.map((c) => (
                    <SelectItem key={c} value={c} className="font-mono">
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Environment">
              <Input
                value={environment}
                onChange={(e) => setEnvironment(e.target.value)}
                className="text-xs"
              />
            </Field>
            <Field label="Provider (optional)">
              <Input
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="font-mono text-xs"
                placeholder="dhan, broker, …"
              />
            </Field>
          </div>
          <Field label="Plaintext value">
            <Textarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              className="font-mono text-xs"
              placeholder="paste the secret value — never logged"
            />
          </Field>
          <Field label="Expires in (hours, optional)">
            <Input
              type="number"
              value={expiresInHours}
              onChange={(e) =>
                setExpiresInHours(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
              className="text-xs"
              placeholder="leave blank for no expiry"
            />
          </Field>
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
            disabled={pending || !path || !value}
            onClick={submit}
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {pending ? "Encrypting…" : "Create Secret"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewVersionDialog({
  secret,
  onOpenChange,
  pending,
  onSubmit,
}: {
  secret: SecretListItem | null;
  onOpenChange: (o: boolean) => void;
  pending: boolean;
  onSubmit: (value: string, expiresInHours?: number) => void;
}) {
  const [value, setValue] = useState("");
  const [expiresInHours, setExpiresInHours] = useState<number | "">("");

  return (
    <Dialog open={!!secret} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-zinc-100">New Version</DialogTitle>
          <DialogDescription className="text-zinc-400">
            Create a new encrypted version for{" "}
            <span className="font-mono text-zinc-300">{secret?.path}</span>. The
            prior active version is retired atomically.
          </DialogDescription>
        </DialogHeader>
        <Field label="Plaintext value">
          <Textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={3}
            className="font-mono text-xs"
          />
        </Field>
        <Field label="Expires in (hours, optional)">
          <Input
            type="number"
            value={expiresInHours}
            onChange={(e) =>
              setExpiresInHours(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            className="text-xs"
          />
        </Field>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
          >
            Cancel
          </Button>
          <Button
            disabled={pending || !value}
            onClick={() =>
              onSubmit(
                value,
                expiresInHours === "" ? undefined : Number(expiresInHours),
              )
            }
            className="bg-emerald-600 text-white hover:bg-emerald-500"
          >
            {pending ? "Encrypting…" : "Create Version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({
  secret,
  onOpenChange,
  pending,
  onSubmit,
}: {
  secret: SecretListItem | null;
  onOpenChange: (o: boolean) => void;
  pending: boolean;
  onSubmit: (expiresInHours?: number) => void;
}) {
  const [expiresInHours, setExpiresInHours] = useState<number | "">(24);
  return (
    <Dialog open={!!secret} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <RefreshCw className="size-4 text-amber-400" />
            Rotate Secret
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Generate a new version of{" "}
            <span className="font-mono text-zinc-300">{secret?.path}</span>. If
            no value is supplied, the backend generates a random value. Audit
            event{" "}
            <span className="font-mono text-zinc-400">secret.rotate</span> is
            recorded.
          </DialogDescription>
        </DialogHeader>
        <Field label="Expires in (hours)">
          <Input
            type="number"
            value={expiresInHours}
            onChange={(e) =>
              setExpiresInHours(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
            className="text-xs"
          />
        </Field>
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
            onClick={() =>
              onSubmit(
                expiresInHours === "" ? undefined : Number(expiresInHours),
              )
            }
            className="bg-amber-600 text-white hover:bg-amber-500"
          >
            {pending ? "Rotating…" : "Rotate"}
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
