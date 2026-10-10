"use client";

import { useState } from "react";
import { UserCog } from "lucide-react";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/vault/client";
import type { ClientListItem } from "@/lib/vault/types";
import { cn } from "@/lib/utils";
import { useVaultStore } from "./store";

/**
 * The "View as Client" dialog. Listed demo service clients (admin-only fetch)
 * and offers an arbitrary-credential paste for non-demo clients. On select,
 * the store's setClientView flips the API client into client mode and all
 * TanStack queries are invalidated so they re-fetch with the new token.
 *
 * Extracted into its own file + lazy-loaded via next/dynamic in the Header so
 * the Dialog/Textarea/Label shadcn families don't bloat the initial shell
 * compilation (keeps Turbopack memory under the 4GB sandbox limit).
 */
export function IdentitySwitcherDialog({
  open,
  onOpenChange,
  workspaceId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workspaceId: string;
}) {
  const setClientView = useVaultStore((s) => s.setClientView);
  const qc = useQueryClient();
  const [pasteToken, setPasteToken] = useState("");
  const [pasteName, setPasteName] = useState("");
  const [pastePublicId, setPastePublicId] = useState("");

  const clientsQ = useQuery({
    queryKey: ["clients", workspaceId, 0],
    queryFn: () => api.listClients(workspaceId),
    enabled: open && !!workspaceId,
    staleTime: 60_000,
  });

  // Credentials are shown once at creation and never stored, so the operator
  // picks a client here and pastes the credential they saved for it.
  function pickClient(client: ClientListItem) {
    setPasteName(client.name);
    setPastePublicId(client.publicId);
  }

  function submitPaste() {
    const name = pasteName.trim() || "external-client";
    const publicId = pastePublicId.trim() || "clt_external";
    if (!pasteToken.trim()) {
      toast.error("Paste a service-client credential first");
      return;
    }
    setClientView(pasteToken.trim(), name, publicId);
    onOpenChange(false);
    qc.invalidateQueries();
    toast.success(`Now viewing as ${name}`);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <UserCog className="size-4 text-amber-400" />
            Switch to Client Identity
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Temporarily impersonate a service client to preview the
            least-privilege surface. Admin-only views return{" "}
            <span className="font-mono text-zinc-300">403 admin_required</span>{" "}
            — that&apos;s the model working as intended.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Service clients
            </Label>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-950/40 p-1.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
              {clientsQ.isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 w-full bg-zinc-800/60" />
                ))
              ) : (
                (clientsQ.data?.clients ?? []).map((client) => (
                  <div
                    key={client.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 text-xs hover:bg-zinc-800/50"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-zinc-100">{client.name}</span>
                        <Badge
                          variant="outline"
                          className="border-zinc-700 bg-zinc-800/40 font-mono text-[9px] uppercase text-zinc-400"
                        >
                          {client.clientType}
                        </Badge>
                      </div>
                      <div className="truncate font-mono text-[10px] text-zinc-500">
                        {client.publicId} · {client.grantsCount} grant{client.grantsCount === 1 ? "" : "s"}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => pickClient(client)}
                      className="h-7 border-amber-700/50 bg-amber-950/40 px-2 text-[11px] text-amber-100 hover:bg-amber-900/50 hover:text-amber-50"
                    >
                      Select
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <Label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
              Credential (shown once when the client was created or rotated)
            </Label>
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input
                  placeholder="Client name"
                  value={pasteName}
                  onChange={(e) => setPasteName(e.target.value)}
                  className="h-9 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                />
                <input
                  placeholder="publicId (clt_…)"
                  value={pastePublicId}
                  onChange={(e) => setPastePublicId(e.target.value)}
                  className="h-9 rounded-md border border-zinc-800 bg-zinc-900/60 px-2 py-1.5 font-mono text-xs text-zinc-200 placeholder:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
                />
              </div>
              <Textarea
                placeholder="vlt_live_…"
                value={pasteToken}
                onChange={(e) => setPasteToken(e.target.value)}
                rows={2}
                className="border-zinc-800 bg-zinc-900/60 font-mono text-xs text-zinc-200"
              />
              <Button
                size="sm"
                onClick={submitPaste}
                disabled={!pasteToken.trim()}
                className="bg-amber-600 text-white hover:bg-amber-500"
              >
                View as pasted credential
              </Button>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
