export interface OnboardingHighlight {
  label: string;
  detail: string;
}

export interface OnboardingSlide {
  id: string;
  kicker: string;
  title: string;
  description: string;
  highlights: OnboardingHighlight[];
  primaryRoute: string;
  primaryCtaLabel: string;
}

export const ONBOARDING_PENDING_SESSION_KEY = "ct:onboarding:pending";

export function onboardingStorageKeys(userId: string): {
  seenKey: string;
  suppressKey: string;
} {
  const safeId = userId.trim() || "operator";
  return {
    seenKey: `ct:onboarding:seen:${safeId}`,
    suppressKey: `ct:onboarding:suppress:${safeId}`,
  };
}

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    id: "command-center",
    kicker: "01 · Operations Overview",
    title: "Monitor your entire freight network from one floor",
    description:
      "Track active shipments, SLA alerts, 7-day CO₂e emissions, and carrier quote conversions across road, air, sea, and rail in real time.",
    highlights: [
      {
        label: "Live KPIs & Corridor Map",
        detail: "Spot stalled consignments and active lanes at a glance.",
      },
      {
        label: "One-Click CSV Export",
        detail: "Pull filtered workspace shipment telemetry whenever needed.",
      },
    ],
    primaryRoute: "/",
    primaryCtaLabel: "Stay on Overview",
  },
  {
    id: "orders-planning",
    kicker: "02 · Intake to Dispatch",
    title: "Turn customer orders into scored carrier dispatches",
    description:
      "Capture single, 3PL multi-client, or international freight orders, then let the planning engine match warehouses, fleet vehicles, and top-rated carriers.",
    highlights: [
      {
        label: "Multi-Vertical Workflows",
        detail: "Courier, enterprise, international customs, and 3PL client accounts.",
      },
      {
        label: "Deterministic Scoring",
        detail: "Rank carriers on on-time rate, damage index, and quoted cost.",
      },
    ],
    primaryRoute: "/orders",
    primaryCtaLabel: "Open Orders",
  },
  {
    id: "exceptions-approvals",
    kicker: "03 · Exceptions & Governance",
    title: "Resolve delays fast with policy-gated approvals",
    description:
      "AI agents investigate route disruptions and recommend recovery options while spend limits and human approvals protect every booking.",
    highlights: [
      {
        label: "Exception Escalation",
        detail: "Automatic detection for customs holds, missed ETAs, and stalled jobs.",
      },
      {
        label: "Audited Sign-Off",
        detail: "Every threshold approval and agent decision is logged cleanly.",
      },
    ],
    primaryRoute: "/exceptions",
    primaryCtaLabel: "View Exceptions",
  },
  {
    id: "command-navigation",
    kicker: "04 · Fast Navigation & Setup",
    title: "Jump to any module or shipment in two keystrokes",
    description:
      "Press ⌘K (or /) from any screen to open the Command Palette, search shipments by reference, and tailor workspace tiers or team roles in Settings.",
    highlights: [
      {
        label: "⌘K Command Palette",
        detail: "Instant keyboard access across all 24 workspace modules.",
      },
      {
        label: "Adaptive Configuration",
        detail: "Scale features and role permissions as your operation grows.",
      },
    ],
    primaryRoute: "/settings",
    primaryCtaLabel: "Workspace Settings",
  },
];

export function clampSlideIndex(index: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), total - 1));
}

export function nextSlideIndex(current: number, total: number): number {
  return clampSlideIndex(current + 1, total);
}

export function prevSlideIndex(current: number, total: number): number {
  return clampSlideIndex(current - 1, total);
}

export function resolveSwipeDirection(
  deltaX: number,
  threshold = 45,
): "next" | "prev" | null {
  if (!Number.isFinite(deltaX)) return null;
  if (deltaX <= -Math.abs(threshold)) return "next";
  if (deltaX >= Math.abs(threshold)) return "prev";
  return null;
}

export function shouldAutoOpenOnboarding(params: {
  hasPendingAuthTrigger: boolean;
  hasSeenTour: boolean;
  suppressOnSignIn: boolean;
  autostartParam: boolean;
}): boolean {
  if (params.autostartParam) return false;
  if (params.suppressOnSignIn) return false;
  if (params.hasPendingAuthTrigger) return true;
  if (!params.hasSeenTour) return true;
  return false;
}

export function markOnboardingPendingAfterAuth(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(ONBOARDING_PENDING_SESSION_KEY, "1");
  } catch {
    // Ignore restricted storage environments
  }
}
