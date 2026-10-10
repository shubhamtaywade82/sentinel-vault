"use client";

import { useState } from "react";
import { GitCompareArrows, Loader2, Plus, Minus, Equal } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/vault/client";
import type { SecretDiffResponse } from "@/lib/vault/types";
import { CopyButton } from "./CopyButton";

/**
 * Secret Version Diff modal — decrypts two versions and shows a line-by-line
 * unified diff. Proves the versioning model: each version is immutable and
 * independently decryptable with AAD bound to its version number.
 * Loads its own version list so it can be opened from anywhere.
 */
export function SecretDiffDialog({
  secretId,
  secretPath,
  versions: propVersions,
  open,
  onOpenChange,
}: {
  secretId: string;
  secretPath: string;
  versions?: { id: string; versionNumber: number; status: string; createdBy: string }[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [versionAId, setVersionAId] = useState<string>("");
  const [versionBId, setVersionBId] = useState<string>("");
  const [diff, setDiff] = useState<SecretDiffResponse | null>(null);

  // Fetch versions if not provided via props
  const versionsQ = useQuery({
    queryKey: ["secret-versions", secretId],
    queryFn: () => api.listVersions(secretId),
    enabled: open && !propVersions,
    staleTime: 30_000,
  });

  const versions =
    propVersions ??
    versionsQ.data?.versions?.map((v) => ({
      id: v.id,
      versionNumber: v.versionNumber,
      status: v.status,
      createdBy: v.createdBy,
    })) ??
    [];

  const diffM = useMutation({
    mutationFn: () => api.diffSecretVersions(secretId, versionAId, versionBId),
    onSuccess: (res) => {
      setDiff(res);
      toast.success(
        `Diff: +${res.stats.additions} −${res.stats.removals} (${res.stats.context} unchanged)`,
      );
    },
    onError: (e) => toast.error(`Diff failed: ${(e as Error).message}`),
  });

  function runDiff() {
    if (!versionAId || !versionBId) {
      toast.error("Select two versions to compare");
      return;
    }
    if (versionAId === versionBId) {
      toast.error("Select two different versions");
      return;
    }
    setDiff(null);
    diffM.mutate();
  }

  const sorted = [...versions].sort((a, b) => b.versionNumber - a.versionNumber);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-zinc-800 bg-zinc-900 text-zinc-100 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-zinc-100">
            <GitCompareArrows className="size-4 text-emerald-400" />
            Compare Versions
          </DialogTitle>
          <DialogDescription className="font-mono text-xs text-zinc-400">
            {secretPath}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Version A (from)
              </Label>
              <Select value={versionAId} onValueChange={setVersionAId}>
                <SelectTrigger className="border-zinc-800 bg-zinc-950/40 font-mono text-xs text-zinc-200">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
                  {sorted.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      v{v.versionNumber} · {v.status} · {v.createdBy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Version B (to)
              </Label>
              <Select value={versionBId} onValueChange={setVersionBId}>
                <SelectTrigger className="border-zinc-800 bg-zinc-950/40 font-mono text-xs text-zinc-200">
                  <SelectValue placeholder="Select version" />
                </SelectTrigger>
                <SelectContent className="border-zinc-800 bg-zinc-900 text-zinc-200">
                  {sorted.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      v{v.versionNumber} · {v.status} · {v.createdBy}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={runDiff}
              disabled={diffM.isPending || !versionAId || !versionBId}
              className="bg-emerald-600 text-white hover:bg-emerald-500"
            >
              {diffM.isPending ? (
                <Loader2 className="mr-1 size-3.5 animate-spin" />
              ) : (
                <GitCompareArrows className="mr-1 size-3.5" />
              )}
              Compare
            </Button>
            {diff && (
              <div className="flex items-center gap-2 text-xs">
                <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                  <Plus className="mr-0.5 size-3" /> {diff.stats.additions}
                </Badge>
                <Badge className="border-rose-500/30 bg-rose-500/10 text-rose-300">
                  <Minus className="mr-0.5 size-3" /> {diff.stats.removals}
                </Badge>
                <Badge className="border-zinc-600/30 bg-zinc-600/10 text-zinc-300">
                  <Equal className="mr-0.5 size-3" /> {diff.stats.context}
                </Badge>
                <span className="font-mono text-[10px] text-zinc-500">
                  {diff.versionA.versionNumber} → {diff.versionB.versionNumber}
                </span>
              </div>
            )}
          </div>

          {diffM.isPending ? (
            <Skeleton className="h-64 w-full bg-zinc-800/60" />
          ) : diff ? (
            <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/60">
              <div className="max-h-80 overflow-y-auto font-mono text-xs [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-zinc-700">
                {diff.diff.map((line, i) => (
                  <div
                    key={i}
                    className={
                      "flex gap-2 px-3 py-0.5 " +
                      (line.type === "add"
                        ? "bg-emerald-500/10 text-emerald-300"
                        : line.type === "remove"
                          ? "bg-rose-500/10 text-rose-300"
                          : "text-zinc-400")
                    }
                  >
                    <span className="w-8 shrink-0 select-none text-right text-zinc-600">
                      {line.aLine ?? line.bLine ?? ""}
                    </span>
                    <span className="w-4 shrink-0 select-none text-center">
                      {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "}
                    </span>
                    <span className="flex-1 break-all whitespace-pre-wrap">
                      {line.text || " "}
                    </span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
                <span className="font-mono text-[10px] text-zinc-500">
                  Cache-Control: no-store · values never logged
                </span>
                <CopyButton text={diff.valueB} label={`Copy v${diff.versionB.versionNumber}`} size="sm" />
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-zinc-800 bg-zinc-950/40 px-4 py-8 text-center text-xs text-zinc-500">
              Select two versions and click Compare to see the decrypted line-by-line diff.
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
