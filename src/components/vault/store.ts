"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type VaultView =
  | "dashboard"
  | "secrets"
  | "clients"
  | "connections"
  | "runs"
  | "audit"
  | "grants"
  | "leases"
  | "workspaces";

export type AuthMode = "admin" | "client";

interface VaultState {
  view: VaultView;
  workspaceId: string;
  adminToken: string;
  refreshTick: number;
  /** Identity-switcher playground state. When authMode === 'client' the
   * dashboard temporarily impersonates a service client credential so the
   * operator can see the least-privilege surface from that client's POV. */
  authMode: AuthMode;
  clientToken: string | null;
  clientName: string | null;
  clientPublicId: string | null;
  setView: (v: VaultView) => void;
  setWorkspaceId: (id: string) => void;
  setAdminToken: (t: string) => void;
  refresh: () => void;
  setClientView: (token: string, name: string, publicId: string) => void;
  exitClientView: () => void;
}

export const useVaultStore = create<VaultState>()(
  persist(
    (set) => ({
      view: "dashboard",
      workspaceId: "",
      adminToken: "vault-admin-demo-token-CHANGE-ME",
      refreshTick: 0,
      authMode: "admin",
      clientToken: null,
      clientName: null,
      clientPublicId: null,
      setView: (view) => set({ view }),
      setWorkspaceId: (workspaceId) => set({ workspaceId }),
      setAdminToken: (adminToken) => set({ adminToken }),
      refresh: () => set((s) => ({ refreshTick: s.refreshTick + 1 })),
      setClientView: (token, name, publicId) => {
        if (typeof window !== "undefined") {
          window.localStorage.setItem("sentinel.clientView", "1");
          window.localStorage.setItem("sentinel.clientToken", token);
          window.localStorage.setItem("sentinel.clientName", name);
          window.localStorage.setItem("sentinel.clientPublicId", publicId);
        }
        set({
          authMode: "client",
          clientToken: token,
          clientName: name,
          clientPublicId: publicId,
        });
      },
      exitClientView: () => {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem("sentinel.clientView");
          window.localStorage.removeItem("sentinel.clientToken");
          window.localStorage.removeItem("sentinel.clientName");
          window.localStorage.removeItem("sentinel.clientPublicId");
        }
        set({
          authMode: "admin",
          clientToken: null,
          clientName: null,
          clientPublicId: null,
        });
      },
    }),
    {
      name: "sentinel-vault-store",
      // Server has no localStorage; hydrating at store creation makes the
      // first client render differ from SSR. Providers rehydrates after mount.
      skipHydration: true,
      partialize: (s) => ({
        workspaceId: s.workspaceId,
        adminToken: s.adminToken,
        // Persist the client-view mode so a page refresh keeps the operator
        // in the least-privilege preview. The actual token is also mirrored
        // to localStorage by setClientView so the API client picks it up
        // before the store rehydrates.
        authMode: s.authMode,
        clientToken: s.clientToken,
        clientName: s.clientName,
        clientPublicId: s.clientPublicId,
      }),
      // Re-mirror the persisted client-view fields to localStorage on hydrate
      // so the API client's getToken() picks them up before React mounts.
      onRehydrateStorage: () => (state) => {
        if (typeof window === "undefined") return;
        if (state?.authMode === "client" && state.clientToken) {
          window.localStorage.setItem("sentinel.clientView", "1");
          window.localStorage.setItem("sentinel.clientToken", state.clientToken);
          if (state.clientName)
            window.localStorage.setItem("sentinel.clientName", state.clientName);
          if (state.clientPublicId)
            window.localStorage.setItem(
              "sentinel.clientPublicId",
              state.clientPublicId,
            );
        }
      },
    },
  ),
);

/**
 * Ensure the admin token from the Zustand store is mirrored to the
 * localStorage key that the API client (`src/lib/vault/client.ts`) reads.
 * Must be called from a client component on mount.
 */
export function syncAdminTokenToLocalStorage(token: string) {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem("sentinel.adminToken", token);
  }
}
