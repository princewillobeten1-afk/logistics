"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";

export interface HeroMetricItem {
  prefix: string;
  target: number;
  suffix: string;
  label: string;
}

export const HERO_METRICS: HeroMetricItem[] = [
  { prefix: "", target: 3, suffix: " min", label: "Mean alert-to-recovery time across contracted backup lanes" },
  { prefix: "", target: 6, suffix: "-factor", label: "Deterministic scoring across rate, SLA, transit, CO₂e, capacity & compliance" },
  { prefix: "", target: 4, suffix: " modes", label: "Unified corridor routing across road, rail, ocean, and priority air" },
  { prefix: "", target: 100, suffix: "%", label: "Pre-award budget enforcement through versioned policy ceilings" },
];

const ANIMATION_DURATION_MS = 1150;
const STAGGER_MS = 90;

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

export function HeroMetricsStrip() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  const [counts, setCounts] = useState<number[]>(() =>
    HERO_METRICS.map((item) => item.target),
  );

  // Trigger count-up once when the metrics strip enters the viewport
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.25 },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Animate values from 0 to target smoothly using requestAnimationFrame
  useEffect(() => {
    if (!inView) return;

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (prefersReducedMotion) {
      setCounts(HERO_METRICS.map((item) => item.target));
      return;
    }

    let rafId = 0;
    const startTs = performance.now();
    setCounts(HERO_METRICS.map(() => 0));

    const step = (now: number) => {
      const elapsed = now - startTs;
      let allFinished = true;

      const nextCounts = HERO_METRICS.map((item, idx) => {
        const localElapsed = Math.max(0, elapsed - idx * STAGGER_MS);
        const progress = Math.min(1, localElapsed / ANIMATION_DURATION_MS);
        if (progress < 1) allFinished = false;
        const eased = easeOutCubic(progress);
        return Math.round(eased * item.target);
      });

      setCounts(nextCounts);

      if (!allFinished) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [inView]);

  return (
    <div
      ref={containerRef}
      className="lp-metric-strip"
      aria-label="Core platform capabilities"
    >
      {HERO_METRICS.map((item, idx) => {
        const displayValue = `${item.prefix}${counts[idx]}${item.suffix}`;
        const finalValue = `${item.prefix}${item.target}${item.suffix}`;

        return (
          <motion.div
            key={item.label}
            className="lp-metric-cell"
            initial={{ opacity: 0, y: 10 }}
            animate={inView ? { opacity: 1, y: 0 } : { opacity: 0.35, y: 10 }}
            transition={{
              duration: 0.42,
              delay: idx * 0.08,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <strong className="lp-metric-value" aria-label={finalValue}>
              {displayValue}
            </strong>
            <span className="lp-metric-label">{item.label}</span>
          </motion.div>
        );
      })}
    </div>
  );
}
