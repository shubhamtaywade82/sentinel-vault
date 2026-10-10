"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({
  text,
  label,
  className,
  size = "icon",
  variant = "ghost",
  toastLabel = "Copied to clipboard",
}: {
  text: string;
  label?: string;
  className?: string;
  size?: "icon" | "sm" | "default";
  variant?: "ghost" | "outline" | "secondary" | "default";
  toastLabel?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for insecure contexts.
        const el = document.createElement("textarea");
        el.value = text;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
      }
      setCopied(true);
      toast.success(toastLabel);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Failed to copy");
    }
  }

  return (
    <Button
      type="button"
      size={size}
      variant={variant}
      onClick={onCopy}
      aria-label={label ?? "Copy"}
      title={copied ? "Copied!" : (label ?? "Copy to clipboard")}
      className={cn(
        "text-zinc-400 transition-transform hover:text-zinc-100 hover:bg-zinc-800 active:scale-95",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-emerald-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {label && (
        <span className={size === "icon" ? "sr-only" : ""}>{label}</span>
      )}
    </Button>
  );
}
