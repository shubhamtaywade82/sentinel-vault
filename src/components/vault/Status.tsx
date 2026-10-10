"use client";

import { AlertTriangle, Ban } from "lucide-react";

export function BackendWarmingBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-2 rounded-md border border-amber-700/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
    >
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-400" />
      <div>
        <span className="font-semibold">Backend warming up</span> — some
        data may be unavailable. The vault API is starting in parallel; lists
        and mutations will populate once ready. The UI is interactive in the
        meantime.
      </div>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon className="size-6 text-zinc-600" />
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {hint && <div className="text-xs text-zinc-500 max-w-md">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * Empty state shown when an admin-only view is requested while the operator
 * is impersonating a service client (the "View as Client" playground).
 */
export function ForbiddenState({
  onExit,
}: {
  onExit?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-amber-800/50 bg-amber-950/30 px-6 py-10 text-center">
      <Ban className="size-6 text-amber-400" />
      <div className="text-sm font-medium text-amber-200">
        Not permitted in client view
      </div>
      <div className="text-xs text-amber-300/70 max-w-md">
        This admin-only surface returns <span className="font-mono">403 admin_required</span> when
        called with a service-client credential. Switch back to admin to access it.
      </div>
      {onExit && (
        <button
          type="button"
          onClick={onExit}
          className="mt-2 rounded-md border border-amber-700/50 bg-amber-900/40 px-3 py-1.5 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-800/50"
        >
          Exit client view
        </button>
      )}
    </div>
  );
}

export function isApiWarmingError(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (!err) return false;
  return (
    err.status === 404 ||
    err.status === 503 ||
    err.status === 500 ||
    (err.message ?? "").toLowerCase().includes("failed to fetch")
  );
}

/**
 * Returns true when the API rejected the request because the caller is not an
 * admin (the "View as Client" playground impersonating a service client).
 * Used by admin-only views to render the friendly ForbiddenState instead of
 * the generic "Backend warming up" banner.
 */
export function isForbidden(e: unknown): boolean {
  const err = e as { code?: string; status?: number };
  if (!err) return false;
  return (
    err.code === "admin_required" ||
    err.code === "forbidden" ||
    err.status === 403
  );
}
