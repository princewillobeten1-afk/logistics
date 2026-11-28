"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Command,
  Compass,
  MapPin,
  PackageCheck,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import {
  ONBOARDING_PENDING_SESSION_KEY,
  ONBOARDING_SLIDES,
  clampSlideIndex,
  nextSlideIndex,
  onboardingStorageKeys,
  prevSlideIndex,
  resolveSwipeDirection,
  shouldAutoOpenOnboarding,
} from "@/lib/onboarding";

const OPEN_EVENT = "ct:open-onboarding";

export function dispatchOpenOnboarding(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

function SlideVisual({ slideId }: { slideId: string }) {
  if (slideId === "command-center") {
    return (
      <div className="onb-preview" aria-hidden="true">
        <div className="onb-preview-head">
          <span className="onb-preview-title">Live Corridor Telemetry</span>
          <span className="onb-preview-tag">LOS → ABV</span>
        </div>
        <div className="onb-preview-metrics">
          <div>
            <span>Active Loads</span>
            <strong>142</strong>
          </div>
          <div>
            <span>On-Time SLA</span>
            <strong>98.4%</strong>
          </div>
          <div>
            <span>7d CO₂e</span>
            <strong>4.2 t</strong>
          </div>
        </div>
        <div className="onb-preview-route">
          <div className="onb-route-node">
            <MapPin size={14} strokeWidth={2} />
            <span>Lagos Hub</span>
          </div>
          <div className="onb-route-line">
            <span className="onb-route-fill" />
          </div>
          <div className="onb-route-node">
            <PackageCheck size={14} strokeWidth={2} />
            <span>Abuja Depot</span>
          </div>
        </div>
      </div>
    );
  }

  if (slideId === "orders-planning") {
    return (
      <div className="onb-preview" aria-hidden="true">
        <div className="onb-preview-head">
          <span className="onb-preview-title">Automated Dispatch Pipeline</span>
          <span className="onb-preview-tag">3 Steps</span>
        </div>
        <div className="onb-pipeline">
          <div className="onb-pipe-step is-done">
            <span className="onb-pipe-num">01</span>
            <div>
              <strong>Order Validated</strong>
              <span>Cargo weight, mode &amp; client SLA verified</span>
            </div>
          </div>
          <div className="onb-pipe-step is-active">
            <span className="onb-pipe-num">02</span>
            <div>
              <strong>Carrier Scored</strong>
              <span>94.8 composite score · Best corridor rate</span>
            </div>
          </div>
          <div className="onb-pipe-step">
            <span className="onb-pipe-num">03</span>
            <div>
              <strong>Fleet &amp; Dock Assigned</strong>
              <span>Warehouse pick ticket dispatched</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (slideId === "exceptions-approvals") {
    return (
      <div className="onb-preview" aria-hidden="true">
        <div className="onb-preview-head">
          <span className="onb-preview-title">Policy &amp; Exception Gate</span>
          <span className="onb-preview-tag is-warn">Human Review</span>
        </div>
        <div className="onb-policy-card">
          <div className="onb-policy-row">
            <ShieldCheck size={16} strokeWidth={2} />
            <div>
              <strong>Spend Authorization Required</strong>
              <span>Reroute quote exceeds automatic corridor cap</span>
            </div>
          </div>
          <div className="onb-policy-meta">
            <span>Carrier Delta: +₦145,000</span>
            <span>·</span>
            <span>ETA Saved: 18h</span>
          </div>
          <div className="onb-policy-actions">
            <span className="onb-mock-btn is-primary">Approve Reroute</span>
            <span className="onb-mock-btn">Request Quote</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="onb-preview" aria-hidden="true">
      <div className="onb-preview-head">
        <span className="onb-preview-title">Command Navigation</span>
        <span className="onb-preview-tag">⌘K / /</span>
      </div>
      <div className="onb-cmd-mock">
        <div className="onb-cmd-bar">
          <Command size={14} strokeWidth={2} />
          <span>Jump to module, shipment ref, or search…</span>
        </div>
        <div className="onb-cmd-rows">
          <div className="onb-cmd-row is-selected">
            <Truck size={14} strokeWidth={1.85} />
            <span>Fleet &amp; Drivers</span>
            <kbd>↵</kbd>
          </div>
          <div className="onb-cmd-row">
            <Compass size={14} strokeWidth={1.85} />
            <span>Shipments Map</span>
            <kbd>/map</kbd>
          </div>
        </div>
      </div>
    </div>
  );
}

const SLIDE_VARIANTS = {
  enter: (dir: number) => ({
    x: dir >= 0 ? 48 : -48,
    opacity: 0,
  }),
  center: {
    x: 0,
    opacity: 1,
  },
  exit: (dir: number) => ({
    x: dir >= 0 ? -48 : 48,
    opacity: 0,
  }),
};

export function OnboardingModal({
  userId,
  userName,
  orgName,
}: {
  userId: string;
  userName: string | null;
  orgName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [suppressFutureSignIns, setSuppressFutureSignIns] = useState(false);
  const pointerStartX = useRef<number | null>(null);
  const pointerStartY = useRef<number | null>(null);

  const total = ONBOARDING_SLIDES.length;
  const currentSlide = ONBOARDING_SLIDES[index] ?? ONBOARDING_SLIDES[0];
  const isFirst = index === 0;
  const isLast = index === total - 1;

  const firstName = (userName ?? "").trim().split(/\s+/)[0] || "Operator";

  useEffect(() => {
    const keys = onboardingStorageKeys(userId);
    let hasPendingAuthTrigger = false;
    let hasSeenTour = false;
    let suppressOnSignIn = false;
    let autostartParam = false;

    try {
      const params = new URLSearchParams(window.location.search);
      autostartParam = params.get("autostart") === "1";

      if (window.sessionStorage.getItem(ONBOARDING_PENDING_SESSION_KEY) === "1") {
        hasPendingAuthTrigger = true;
        window.sessionStorage.removeItem(ONBOARDING_PENDING_SESSION_KEY);
      }

      hasSeenTour = window.localStorage.getItem(keys.seenKey) === "1";
      suppressOnSignIn = window.localStorage.getItem(keys.suppressKey) === "1";
      setSuppressFutureSignIns(suppressOnSignIn);
    } catch {
      // Ignore storage access restrictions
    }

    if (
      shouldAutoOpenOnboarding({
        hasPendingAuthTrigger,
        hasSeenTour,
        suppressOnSignIn,
        autostartParam,
      })
    ) {
      setIndex(0);
      setDirection(1);
      setOpen(true);
    }

    const onManualOpen = () => {
      setIndex(0);
      setDirection(1);
      setOpen(true);
    };
    window.addEventListener(OPEN_EVENT, onManualOpen);
    return () => window.removeEventListener(OPEN_EVENT, onManualOpen);
  }, [userId]);

  const persistPreferences = useCallback(
    (nextSuppress: boolean) => {
      const keys = onboardingStorageKeys(userId);
      try {
        window.localStorage.setItem(keys.seenKey, "1");
        if (nextSuppress) {
          window.localStorage.setItem(keys.suppressKey, "1");
        } else {
          window.localStorage.removeItem(keys.suppressKey);
        }
      } catch {
        // Ignore storage errors
      }
    },
    [userId],
  );

  const closeAndPersist = useCallback(() => {
    persistPreferences(suppressFutureSignIns);
    setOpen(false);
  }, [persistPreferences, suppressFutureSignIns]);

  const goTo = useCallback(
    (targetIdx: number) => {
      const clamped = clampSlideIndex(targetIdx, total);
      if (clamped === index) return;
      setDirection(clamped > index ? 1 : -1);
      setIndex(clamped);
    },
    [index, total],
  );

  const goNext = useCallback(() => {
    if (isLast) {
      closeAndPersist();
      return;
    }
    setDirection(1);
    setIndex((prev) => nextSlideIndex(prev, total));
  }, [closeAndPersist, isLast, total]);

  const goPrev = useCallback(() => {
    if (isFirst) return;
    setDirection(-1);
    setIndex((prev) => prevSlideIndex(prev, total));
  }, [isFirst, total]);

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndPersist();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (!isLast) {
          setDirection(1);
          setIndex((prev) => nextSlideIndex(prev, total));
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!isFirst) {
          setDirection(-1);
          setIndex((prev) => prevSlideIndex(prev, total));
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeAndPersist, isFirst, isLast, open, total]);

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, a, input, label")) return;
    pointerStartX.current = e.clientX;
    pointerStartY.current = e.clientY;
  }

  function handlePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerStartX.current === null || pointerStartY.current === null) return;
    const dx = e.clientX - pointerStartX.current;
    const dy = e.clientY - pointerStartY.current;
    pointerStartX.current = null;
    pointerStartY.current = null;
    if (Math.abs(dx) <= Math.abs(dy)) return;
    const dir = resolveSwipeDirection(dx);
    if (dir === "next" && !isLast) goNext();
    else if (dir === "prev" && !isFirst) goPrev();
  }

  function handlePrimaryModuleJump() {
    const target = currentSlide.primaryRoute;
    closeAndPersist();
    if (target && target !== window.location.pathname) {
      router.push(target);
    }
  }

  function toggleSuppress(checked: boolean) {
    setSuppressFutureSignIns(checked);
    persistPreferences(checked);
  }

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="onb-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={closeAndPersist}
        >
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-labelledby="onb-slide-title"
            className="onb-dialog"
            initial={{ opacity: 0, y: 10, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.985 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header with workspace welcome, step counter, Skip & Close */}
            <header className="onb-header">
              <div className="onb-header-context">
                <Compass size={15} strokeWidth={2} aria-hidden="true" />
                <span>
                  Welcome, {firstName} &middot; {orgName}
                </span>
              </div>
              <div className="onb-header-actions">
                <span className="onb-step-counter" aria-live="polite">
                  {index + 1} of {total}
                </span>
                <button
                  type="button"
                  className="onb-skip-btn"
                  onClick={closeAndPersist}
                >
                  Skip tour
                </button>
                <button
                  type="button"
                  className="onb-close-btn"
                  aria-label="Close onboarding tour"
                  onClick={closeAndPersist}
                >
                  <X size={15} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            </header>

            {/* Segmented progress bar */}
            <div className="onb-progress-track" role="tablist" aria-label="Onboarding steps">
              {ONBOARDING_SLIDES.map((slide, idx) => (
                <button
                  key={slide.id}
                  type="button"
                  role="tab"
                  aria-selected={idx === index}
                  aria-label={`Step ${idx + 1}: ${slide.title}`}
                  className="onb-progress-segment"
                  data-state={
                    idx === index ? "active" : idx < index ? "complete" : "upcoming"
                  }
                  onClick={() => goTo(idx)}
                />
              ))}
            </div>

            {/* Swipeable horizontal slide viewport */}
            <div
              className="onb-stage"
              data-testid="onboarding-stage"
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
            >
              <button
                type="button"
                className="onb-side-arrow onb-side-prev"
                onClick={goPrev}
                disabled={isFirst}
                aria-label="Slide left to previous step"
              >
                <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
              </button>

              <div className="onb-slide-viewport">
                <AnimatePresence mode="wait" custom={direction}>
                  <motion.div
                    key={currentSlide.id}
                    custom={direction}
                    variants={SLIDE_VARIANTS}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                    className="onb-slide-grid"
                  >
                    <div className="onb-copy">
                      <span className="onb-kicker">{currentSlide.kicker}</span>
                      <h2 id="onb-slide-title">{currentSlide.title}</h2>
                      <p className="onb-desc">{currentSlide.description}</p>

                      <ul className="onb-highlights">
                        {currentSlide.highlights.map((item) => (
                          <li key={item.label}>
                            <CheckCircle2
                              size={15}
                              strokeWidth={2}
                              aria-hidden="true"
                              className="onb-check-icon"
                            />
                            <div>
                              <strong>{item.label}</strong>
                              <span>{item.detail}</span>
                            </div>
                          </li>
                        ))}
                      </ul>

                      {currentSlide.primaryRoute !== "/" ? (
                        <div className="onb-inline-cta">
                          <button
                            type="button"
                            className="onb-module-link"
                            onClick={handlePrimaryModuleJump}
                          >
                            <span>{currentSlide.primaryCtaLabel}</span>
                            <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                          </button>
                        </div>
                      ) : null}
                    </div>

                    <div className="onb-media">
                      <SlideVisual slideId={currentSlide.id} />
                    </div>
                  </motion.div>
                </AnimatePresence>
              </div>

              <button
                type="button"
                className="onb-side-arrow onb-side-next"
                onClick={goNext}
                disabled={isLast}
                aria-label="Slide right to next step"
              >
                <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            {/* Footer controls: Left/Right nav, Dots, Don't show again option */}
            <footer className="onb-footer">
              <label className="onb-suppress-check">
                <input
                  type="checkbox"
                  checked={suppressFutureSignIns}
                  onChange={(e) => toggleSuppress(e.target.checked)}
                />
                <span>Don&apos;t show automatically at sign-in</span>
              </label>

              <div className="onb-dots" aria-hidden="true">
                {ONBOARDING_SLIDES.map((s, idx) => (
                  <span
                    key={s.id}
                    className="onb-dot"
                    data-active={idx === index}
                  />
                ))}
              </div>

              <div className="onb-footer-nav">
                <button
                  type="button"
                  className="onb-btn-secondary"
                  onClick={goPrev}
                  disabled={isFirst}
                >
                  <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
                  <span>Previous</span>
                </button>
                <button
                  type="button"
                  className="onb-btn-primary"
                  onClick={goNext}
                >
                  <span>{isLast ? "Get Started" : "Next"}</span>
                  {!isLast ? (
                    <ArrowRight size={14} strokeWidth={2} aria-hidden="true" />
                  ) : null}
                </button>
              </div>
            </footer>
          </motion.section>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
