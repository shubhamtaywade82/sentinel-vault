"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff, ShieldAlert, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyButton } from "./CopyButton";
import { cn } from "@/lib/utils";

/**
 * A masked-then-revealed plaintext panel with a copy button and a no-store
 * notice. The parent controls the value via `value` and may reset it.
 */
export function SecretValueReveal({
  value,
  label = "Plaintext value",
  notice = "Cache-Control: no-store · value never logged",
  className,
  autoFocusReveal = false,
}: {
  value: string;
  label?: string;
  notice?: string;
  className?: string;
  autoFocusReveal?: boolean;
}) {
  const [revealed, setRevealed] = useState(autoFocusReveal);
  const [autoMask, setAutoMask] = useState(false);

  // Auto-mask after 30s when toggled (defense-in-depth).
  useEffect(() => {
    if (!autoMask || !revealed) return;
    const t = setTimeout(() => setRevealed(false), 30_000);
    return () => clearTimeout(t);
  }, [autoMask, revealed]);

  return (
    <div
      className={cn(
        "rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 space-y-3",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          {label}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setRevealed((r) => !r)}
            aria-label={revealed ? "Mask value" : "Reveal value"}
            className="h-8 text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800"
          >
            {revealed ? (
              <EyeOff className="size-3.5" />
            ) : (
              <Eye className="size-3.5" />
            )}
            <span className="text-xs">{revealed ? "Mask" : "Reveal"}</span>
          </Button>
          <CopyButton
            text={value}
            label="Copy"
            size="sm"
            variant="ghost"
            toastLabel="Value copied"
          />
        </div>
      </div>
      <pre
        className="font-mono text-sm break-all whitespace-pre-wrap rounded-md border border-zinc-800 bg-zinc-900/70 p-3 text-zinc-100 tabular-nums min-h-12"
        aria-label="plaintext value"
      >
        {revealed ? value : maskValue(value)}
      </pre>
      <div className="flex items-start gap-2 text-[11px] text-zinc-500">
        <ShieldAlert className="size-3.5 mt-0.5 text-amber-400/80 shrink-0" />
        <span className="font-mono">{notice}</span>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-400 select-none">
        <input
          type="checkbox"
          checked={autoMask}
          onChange={(e) => setAutoMask(e.target.checked)}
          className="accent-emerald-500 size-3.5"
        />
        Auto-mask after 30 seconds
      </label>
    </div>
  );
}

function maskValue(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return (
    v.slice(0, 4) +
    "•".repeat(Math.min(v.length - 8, 24)) +
    v.slice(-4)
  );
}

export { ShieldCheck };
