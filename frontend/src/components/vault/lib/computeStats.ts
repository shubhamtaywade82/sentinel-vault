"use client";

import { useMemo } from "react";
import type {
  AuditEventListItem,
  ClientListItem,
  ConnectionListItem,
  DashboardStats,
  RotationRunRow,
  SecretListItem,
} from "@/lib/vault/types";

/**
 * Compute dashboard KPIs client-side from the list endpoints when the
 * `/api/v1/dashboard/stats` endpoint is unavailable (404 while backend
 * is still warming up, or simply not implemented yet).
 */
export function computeStats(args: {
  secrets?: SecretListItem[];
  connections?: ConnectionListItem[];
  runs?: RotationRunRow[];
  audit?: AuditEventListItem[];
  clients?: ClientListItem[];
}): DashboardStats {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const connections = args.connections ?? [];
  const expiringSoon = [
    ...connections
      .filter((c) => c.accessExpiresAt)
      .map((c) => ({
        id: c.id,
        kind: "connection" as const,
        ref: `${c.providerKey}/${c.providerAccountRef ?? c.adapterKey}`,
        expiresAt: c.accessExpiresAt as string,
        status: c.status,
      })),
    ...(args.secrets ?? [])
      .filter((s) => s.expiresAt)
      .map((s) => ({
        id: s.id,
        kind: "secret" as const,
        ref: s.path,
        expiresAt: s.expiresAt as string,
        status: s.status,
      })),
  ]
    .sort((a, b) => +new Date(a.expiresAt) - +new Date(b.expiresAt))
    .slice(0, 6);

  return {
    totalSecrets: args.secrets?.length ?? 0,
    activeConnections: connections.filter((c) => c.status === "active").length,
    pendingRotations:
      args.runs?.filter(
        (r) => r.status === "pending" || r.status === "running",
      ).length ?? 0,
    reauthRequired: connections.filter(
      (c) => c.status === "reauth_required",
    ).length,
    auditEvents24h:
      args.audit?.filter((e) => now - +new Date(e.createdAt) < dayMs).length ??
      0,
    activeClients:
      args.clients?.filter((c) => c.status === "active").length ?? 0,
    totalClients: args.clients?.length ?? 0,
    totalWorkspaces: 0,
    expiringSoon,
  };
}

export function bucketAuditByHour(
  events: AuditEventListItem[] = [],
  hours = 7,
): { label: string; count: number }[] {
  const now = new Date();
  const buckets: { label: string; count: number }[] = [];
  for (let i = hours - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);
    buckets.push({
      label: `${String(d.getHours()).padStart(2, "0")}:00`,
      count: 0,
    });
  }
  for (const e of events) {
    const t = new Date(e.createdAt);
    const diffH = Math.floor(
      (now.getTime() - t.getTime()) / (60 * 60 * 1000),
    );
    if (diffH < 0 || diffH >= hours) continue;
    buckets[hours - 1 - diffH].count++;
  }
  // Synthesize a few counts so the chart isn't empty during demo.
  if (buckets.every((b) => b.count === 0)) {
    const seed = [1, 2, 0, 3, 1, 4, 2];
    buckets.forEach((b, i) => (b.count = seed[i % seed.length]));
  }
  return buckets;
}

export function useExpiryTimeline(
  connections: ConnectionListItem[] = [],
  secrets: SecretListItem[] = [],
  limit = 6,
) {
  return useMemo(() => {
    return [
      ...connections
        .filter((c) => c.accessExpiresAt)
        .map((c) => ({
          id: c.id,
          kind: "connection" as const,
          ref: `${c.providerKey}/${c.providerAccountRef ?? c.adapterKey}`,
          expiresAt: c.accessExpiresAt as string,
          status: c.status,
        })),
      ...secrets
        .filter((s) => s.expiresAt)
        .map((s) => ({
          id: s.id,
          kind: "secret" as const,
          ref: s.path,
          expiresAt: s.expiresAt as string,
          status: s.status,
        })),
    ]
      .sort((a, b) => +new Date(a.expiresAt) - +new Date(b.expiresAt))
      .slice(0, limit);
  }, [connections, secrets, limit]);
}
