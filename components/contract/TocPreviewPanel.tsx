"use client";

import { useState } from "react";
import type { TocEntry } from "../../lib/docling-adapter";

interface TocPreviewPanelProps {
  tocEntries: TocEntry[];
  warnings?: string[];
}

const INDENT_PER_LEVEL = 16; // px per level beyond 1

export function TocPreviewPanel({ tocEntries, warnings }: TocPreviewPanelProps) {
  const [open, setOpen] = useState(false);

  if (tocEntries.length === 0) return null;

  return (
    <div
      style={{
        marginBottom: 16,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--bg-secondary)",
        overflow: "hidden",
      }}
    >
      {/* Warning banner */}
      {warnings && warnings.length > 0 && (
        <div
          style={{
            background: "rgba(251,191,36,0.10)",
            borderBottom: "1px solid rgba(251,191,36,0.25)",
            padding: "6px 12px",
            fontSize: 12,
            color: "var(--accent-yellow)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
          role="alert"
        >
          {warnings.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
      )}

      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--text-secondary)",
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        <span
          style={{
            display: "inline-block",
            transition: "transform 0.2s",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            fontSize: 10,
          }}
        >
          &#9654;
        </span>
        <span>목차 미리보기</span>
        <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontWeight: 400 }}>
          {tocEntries.length}항목
        </span>
      </button>

      {/* Collapsible entry list */}
      {open && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "8px 0",
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {tocEntries.map((entry, i) => {
            const indent = (Math.max(1, entry.level) - 1) * INDENT_PER_LEVEL;
            return (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 6,
                  paddingLeft: 12 + indent,
                  paddingRight: 12,
                  paddingTop: 3,
                  paddingBottom: 3,
                  fontSize: 12,
                  color: entry.level <= 1 ? "var(--text-secondary)" : "var(--text-muted)",
                }}
              >
                {/* Numbering prefix */}
                {entry.numbering && (
                  <span
                    style={{
                      flexShrink: 0,
                      fontFamily: "monospace",
                      color: "var(--text-muted)",
                      minWidth: 28,
                    }}
                  >
                    {entry.numbering}
                  </span>
                )}

                {/* Title */}
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {entry.title}
                </span>

                {/* Page number */}
                {entry.page_number != null && (
                  <span
                    style={{
                      flexShrink: 0,
                      marginLeft: 8,
                      color: "var(--text-muted)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    p.{entry.page_number}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
