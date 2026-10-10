"use client";

import { useState } from "react";
import { Building2, Plus } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";

import { api } from "@/lib/vault/client";
import type { WorkspaceRow } from "@/lib/vault/types";
import { useVaultStore } from "../store";
import { StatusBadge } from "../StatusBadge";
import { RelativeTime } from "../RelativeTime";
import { EmptyState, ForbiddenState, isApiWarmingError, isForbidden } from "../Status";
import { cn } from "@/lib/utils";

export function WorkspacesView() {
  const setWorkspaceId = useVaultStore((s) => s.setWorkspaceId);
  const refreshTick = useVaultStore((s) => s.refreshTick);
  const qc = useQueryClient();

  const [newOpen, setNewOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");

  const workspacesQ = useQuery({
    queryKey: ["workspaces", refreshTick],
    queryFn: () => api.listWorkspaces(),
  });

  // For per-workspace counts, fetch clients/secrets/connections counts lazily.
  // We compute counts from list endpoints to avoid requiring a stats endpoint.
  const clientsByWs = useQuery({
    queryKey: ["clients-all-workspaces", refreshTick],
    queryFn: async () => {
      const ws = workspacesQ.data?.workspaces ?? [];
      const out: Record<string, number> = {};
      for (const w of ws) {
        try {
          const r = await api.listClients(w.id);
          out[w.id] = r.clients.length;
        } catch {
          out[w.id] = 0;
        }
      }
      return out;
    },
    enabled: !!workspacesQ.data,
  });
  const secretsByWs = useQuery({
    queryKey: ["secrets-all-workspaces", refreshTick],
    queryFn: async () => {
      const ws = workspacesQ.data?.workspaces ?? [];
      const out: Record<string, number> = {};
      for (const w of ws) {
        try {
          const r = await api.listSecrets(w.id);
          out[w.id] = r.secrets.length;
        } catch {
          out[w.id] = 0;
        }
      }
      return out;
    },
    enabled: !!workspacesQ.data,
  });
  const connectionsByWs = useQuery({
    queryKey: ["connections-all-workspaces", refreshTick],
    queryFn: async () => {
      const ws = workspacesQ.data?.workspaces ?? [];
      const out: Record<string, number> = {};
      for (const w of ws) {
        try {
          const r = await api.listConnections(w.id);
          out[w.id] = r.connections.length;
        } catch {
          out[w.id] = 0;
        }
      }
      return out;
    },
    enabled: !!workspacesQ.data,
  });

  const warming = workspacesQ.isError && isApiWarmingError(workspacesQ.error);
  const forbidden = workspacesQ.isError && isForbidden(workspacesQ.error);
  const workspaces = workspacesQ.data?.workspaces ?? [];

  const createM = useMutation({
    mutationFn: (input: { slug: string; name: string }) =>
      api.createWorkspace(input.slug, input.name),
    onSuccess: () => {
      toast.success("Workspace created");
      setNewOpen(false);
      setSlug("");
      setName("");
      qc.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (e) => toast.error(`Create failed: ${(e as Error).message}`),
  });

  return (
    <div className="vault-enter space-y-4"
    >
      {warming && (
        <div className="rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          Backend warming up — workspace list may be empty.
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Workspaces</h1>
          <p className="text-xs text-zinc-500">
            Tenant isolation boundary. All secrets, clients, and connections
            are scoped to a workspace.
          </p>
        </div>
        <Button
          onClick={() => setNewOpen(true)}
          disabled={forbidden}
          className="min-h-11 bg-emerald-600 text-white hover:bg-emerald-500"
        >
          <Plus className="size-4" />
          New Workspace
        </Button>
      </div>

      {forbidden ? (
        <ForbiddenState />
      ) : workspacesQ.isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-32 w-full rounded-lg bg-zinc-800/60"
            />
          ))}
        </div>
      ) : workspaces.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No workspaces"
          hint="Create a workspace, or seed the vault from the dashboard to get the production/staging/development defaults."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((w) => (
            <WorkspaceCard
              key={w.id}
              workspace={w}
              clients={clientsByWs.data?.[w.id] ?? 0}
              secrets={secretsByWs.data?.[w.id] ?? 0}
              connections={connectionsByWs.data?.[w.id] ?? 0}
              onSelect={() => setWorkspaceId(w.id)}
            />
          ))}
        </div>
      )}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-zinc-100">New Workspace</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Create a tenant-isolated workspace. The slug is the canonical key
              for cross-API references.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
                Slug
              </Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                className="font-mono text-xs"
                placeholder="staging"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[11px] uppercase tracking-wide text-zinc-500">
                Name
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="text-xs"
                placeholder="Staging"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewOpen(false)}
              className="border-zinc-800 bg-zinc-950 text-zinc-300 hover:bg-zinc-800"
            >
              Cancel
            </Button>
            <Button
              disabled={createM.isPending || !slug || !name}
              onClick={() => createM.mutate({ slug, name })}
              className="bg-emerald-600 text-white hover:bg-emerald-500"
            >
              {createM.isPending ? "Creating…" : "Create Workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WorkspaceCard({
  workspace,
  clients,
  secrets,
  connections,
  onSelect,
}: {
  workspace: WorkspaceRow;
  clients: number;
  secrets: number;
  connections: number;
  onSelect: () => void;
}) {
  return (
    <Card
      className={cn(
        "vault-card vault-card-interactive rounded-lg border border-zinc-800 p-5 transition-colors hover:border-zinc-700",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onSelect}
          className="text-left"
          aria-label={`Select workspace ${workspace.slug}`}
        >
          <div className="font-mono text-sm text-emerald-300">
            {workspace.slug}
          </div>
          <div className="text-xs text-zinc-400">{workspace.name}</div>
        </button>
        <StatusBadge status={workspace.status} />
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label="Clients" value={clients} />
        <Stat label="Secrets" value={secrets} />
        <Stat label="Conns" value={connections} />
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px] text-zinc-600">
        <span>created <RelativeTime value={workspace.createdAt} /></span>
        <Badge
          variant="outline"
          className="border-zinc-700 bg-zinc-800/40 font-mono text-[10px] text-zinc-500"
        >
          {workspace.id.slice(0, 8)}…
        </Badge>
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-2 py-1.5">
      <div className="font-mono text-lg tabular-nums text-zinc-200">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
    </div>
  );
}
