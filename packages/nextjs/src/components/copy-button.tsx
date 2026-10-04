"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CopyButton({ code, label }: { code: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "error">("idle");
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timeout.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setState("copied");
    } catch {
      setState("error");
    }
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setState("idle"), 2500);
  }

  return (
    <button
      type="button"
      className="copy-button"
      onClick={copy}
      aria-label={`Copy ${label.toLowerCase()}`}
    >
      {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      <span aria-live="polite">
        {state === "copied" ? "Copied" : state === "error" ? "Select to copy" : "Copy"}
      </span>
    </button>
  );
}
