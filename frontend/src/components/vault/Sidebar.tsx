"use client";

import { NAV_ITEMS } from "./NavItems";
import { useVaultStore } from "./store";
import { cn } from "@/lib/utils";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const view = useVaultStore((s) => s.view);
  const setView = useVaultStore((s) => s.setView);

  return (
    <nav
      aria-label="Primary"
      className="flex h-full flex-col gap-1 px-3 py-4"
    >
      <div className="mb-1 mt-2 border-b border-zinc-800/50 px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.15em] text-zinc-500">
        Operations
      </div>
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = view === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setView(item.id);
              onNavigate?.();
            }}
            aria-current={active ? "page" : undefined}
            className={cn(
              "vault-nav-item group relative flex min-h-11 items-center gap-3 rounded-md border-l-2 px-3 py-2 text-left text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
              active
                ? "vault-nav-active border-emerald-500 text-zinc-100 shadow-[inset_2px_0_0_0_rgb(16_185_129)]"
                : "border-transparent text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-100",
            )}
          >
            <Icon
              className={cn(
                "size-4 shrink-0",
                active
                  ? "text-emerald-400"
                  : "text-zinc-500 group-hover:text-zinc-300",
              )}
            />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium leading-tight">{item.label}</span>
              <span
                className={cn(
                  "truncate text-[10px] leading-tight",
                  active ? "text-zinc-500" : "text-zinc-600",
                )}
              >
                {item.description}
              </span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}
