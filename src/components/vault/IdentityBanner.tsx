"use client";

import { Ban, Eye } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useVaultStore } from "./store";

/**
 * Sticky amber banner shown below the header while the operator is
 * impersonating a service client via the "View as Client" playground.
 * Reminds the operator that the dashboard is in least-privilege preview
 * mode and offers a one-click exit back to admin.
 */
export function IdentityBanner() {
  const authMode = useVaultStore((s) => s.authMode);
  const clientName = useVaultStore((s) => s.clientName);
  const clientPublicId = useVaultStore((s) => s.clientPublicId);
  const exitClientView = useVaultStore((s) => s.exitClientView);
  const qc = useQueryClient();

  if (authMode !== "client") return null;

  function onExit() {
    exitClientView();
    qc.invalidateQueries();
    toast.success("Returned to admin view");
  }

  return (
    <div
      role="status"
      className="sticky top-14 z-30 flex flex-wrap items-center gap-2 border-b border-amber-800/50 bg-amber-950/40 px-3 py-2 text-xs text-amber-200 backdrop-blur supports-[backdrop-filter]:bg-amber-950/30 sm:px-4"
    >
      <Eye className="size-3.5 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-amber-100">
          Viewing as {clientName}
        </span>
        {clientPublicId && (
          <span className="ml-1.5 font-mono text-[11px] text-amber-300/80">
            ({clientPublicId})
          </span>
        )}
        <span className="ml-1.5 text-amber-300/70">
          — least-privilege preview. Admin-only surfaces return 403.
        </span>
      </div>
      <Button
        size="sm"
        onClick={onExit}
        className="h-7 border-amber-700/60 bg-amber-900/60 px-2 text-[11px] text-amber-100 hover:bg-amber-800/70 hover:text-amber-50"
      >
        <Ban className="size-3" />
        Exit client view
      </Button>
    </div>
  );
}
