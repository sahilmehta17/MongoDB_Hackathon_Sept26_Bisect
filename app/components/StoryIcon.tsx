import type { RowKind } from "@/lib/story";

// One simple icon per row type (inline SVG: renders the same on every machine). The shield is
// reserved for memory.
export default function StoryIcon({ kind }: { kind: RowKind }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", "aria-hidden": true, focusable: false } as const;
  switch (kind) {
    case "routine":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
    case "accepted":
      return (
        <svg {...common}>
          <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "live":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="6" fill="currentColor" />
        </svg>
      );
    case "blocked_tests":
      return (
        <svg {...common}>
          <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      );
    case "alarm":
      return (
        <svg {...common}>
          <path d="M12 4l9 16H3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    case "bisect":
      return (
        <svg {...common}>
          <path d="M12 3.5l8.5 8.5-8.5 8.5L3.5 12z" fill="currentColor" />
        </svg>
      );
    case "remembered":
    case "blocked_memory":
      return (
        <svg {...common}>
          <path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.9-7.5-9.5V6z" fill="currentColor" />
          {kind === "blocked_memory" && <path d="M8.8 12.2l2.3 2.3 4.2-4.6" fill="none" stroke="var(--bg)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      );
    case "needs_person":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M12 7.5v5M12 15.8v.3" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M7 12h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
      );
  }
}
