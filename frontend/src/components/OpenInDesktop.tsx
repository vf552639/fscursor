import React from "react";
import { isTauri } from "../lib/runtime";
import { Btn } from "./ui/Primitives";

export interface OpenInDesktopProps {
  /** Path or query-style action, e.g. `provision?domainId=3` (becomes `sdmp://provision?domainId=3`). */
  action: string;
  label: React.ReactNode;
  desktopOnClick: () => void;
  variant?: "primary" | "secondary" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
  title?: string;
}

export function openInDesktopHref(action: string): string {
  const path = action.startsWith("sdmp:") ? action : `sdmp://${action.replace(/^\/*/, "")}`;
  return path;
}

export function OpenInDesktop({
  action,
  label,
  desktopOnClick,
  variant = "secondary",
  size = "sm",
  disabled = false,
  title,
}: OpenInDesktopProps) {
  if (isTauri()) {
    return (
      <Btn variant={variant} size={size} onClick={desktopOnClick} disabled={disabled} title={title}>
        {label}
      </Btn>
    );
  }
  const href = openInDesktopHref(action);
  return (
    <a
      href={href}
      title={title ?? "Opens in the SDMP desktop app"}
      aria-disabled={disabled || undefined}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: size === "sm" ? "6px 12px" : "8px 14px",
        fontSize: size === "sm" ? 12.5 : 13,
        fontWeight: 600,
        borderRadius: 8,
        textDecoration: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        pointerEvents: disabled ? "none" : "auto",
        border:
          variant === "primary"
            ? "1px solid #2563eb"
            : variant === "danger"
              ? "1px solid #fecaca"
              : "1px solid #e5e7eb",
        background: variant === "primary" ? "#2563eb" : variant === "danger" ? "#fef2f2" : "#fff",
        color: variant === "primary" ? "#fff" : variant === "danger" ? "#b91c1c" : "#374151",
      }}
    >
      {label} ↗
    </a>
  );
}
