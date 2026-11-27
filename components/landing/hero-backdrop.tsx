import Image from "next/image";

const CORRIDOR_PATHS = [
  {
    id: "north-arc",
    d: "M -40 165 C 210 58, 430 48, 690 120 C 960 194, 1210 156, 1480 62",
    tone: "teal",
    dur: "9.5s",
    begin: "0s",
    width: 1.6,
  },
  {
    id: "express-rail",
    d: "M -40 288 C 190 228, 395 194, 620 238 C 890 290, 1170 250, 1480 152",
    tone: "teal",
    dur: "7.8s",
    begin: "-2.4s",
    width: 1.35,
  },
  {
    id: "maritime-south",
    d: "M -40 432 C 215 390, 440 462, 720 422 C 985 384, 1225 418, 1480 340",
    tone: "amber",
    dur: "11.2s",
    begin: "-4.1s",
    width: 1.35,
  },
  {
    id: "bypass-upper",
    d: "M 48 64 C 290 142, 465 182, 720 112 C 985 38, 1215 88, 1430 228",
    tone: "slate",
    dur: "10.6s",
    begin: "-1.5s",
    width: 1.15,
  },
  {
    id: "cross-link-left",
    d: "M 135 510 C 210 385, 290 278, 398 188 C 495 108, 610 68, 720 44",
    tone: "teal",
    dur: "8.6s",
    begin: "-3.2s",
    width: 1.15,
  },
  {
    id: "cross-link-right",
    d: "M 720 44 C 865 80, 995 148, 1110 258 C 1215 358, 1300 445, 1390 525",
    tone: "amber",
    dur: "8.9s",
    begin: "-5.1s",
    width: 1.15,
  },
] as const;

const HUB_NODES = [
  { x: 185, y: 122, r: 5, tone: "teal" },
  { x: 265, y: 245, r: 4.5, tone: "teal" },
  { x: 192, y: 406, r: 4.5, tone: "amber" },
  { x: 398, y: 188, r: 4, tone: "slate" },
  { x: 1055, y: 162, r: 4.5, tone: "teal" },
  { x: 1175, y: 246, r: 5, tone: "teal" },
  { x: 1235, y: 386, r: 4.5, tone: "amber" },
  { x: 1320, y: 114, r: 4, tone: "slate" },
] as const;

const COMPASS_TICKS = Array.from({ length: 24 }, (_, idx) => {
  const angleRad = (idx * 15 * Math.PI) / 180;
  const cx = 720;
  const cy = 230;
  const rInner = idx % 2 === 0 ? 352 : 358;
  const rOuter = 368;
  return {
    x1: cx + Math.cos(angleRad) * rInner,
    y1: cy + Math.sin(angleRad) * rInner,
    x2: cx + Math.cos(angleRad) * rOuter,
    y2: cy + Math.sin(angleRad) * rOuter,
    major: idx % 2 === 0,
  };
});

export function HeroBackdrop() {
  return (
    <div className="lp-hero-backdrop" aria-hidden="true">
      {/* Peripheral Freight Terminal Photography masked smoothly into alabaster */}
      <div className="lp-hero-photo-layer">
        <Image
          src="/images/landing/hero-terminal.jpg"
          alt=""
          fill
          priority
          sizes="100vw"
          className="lp-hero-photo-img"
          referrerPolicy="no-referrer"
        />
      </div>

      {/* Subtle architectural coordinate grid */}
      <div className="lp-hero-grid-bg" />

      {/* Center-cleared Control Tower azimuth rings & animated corridor network */}
      <svg
        viewBox="0 0 1440 560"
        preserveAspectRatio="xMidYMid slice"
        className="lp-hero-network-svg"
      >
        <defs>
          <radialGradient id="lpHeroRingFade" cx="50%" cy="41%" r="54%">
            <stop offset="0%" stopColor="rgba(13, 107, 99, 0.04)" />
            <stop offset="55%" stopColor="rgba(13, 107, 99, 0.16)" />
            <stop offset="100%" stopColor="rgba(13, 107, 99, 0.02)" />
          </radialGradient>

          <linearGradient id="lpArcTeal" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(13, 107, 99, 0.08)" />
            <stop offset="22%" stopColor="rgba(13, 107, 99, 0.34)" />
            <stop offset="50%" stopColor="rgba(13, 107, 99, 0.1)" />
            <stop offset="78%" stopColor="rgba(13, 107, 99, 0.34)" />
            <stop offset="100%" stopColor="rgba(13, 107, 99, 0.08)" />
          </linearGradient>

          <linearGradient id="lpArcAmber" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(180, 83, 9, 0.06)" />
            <stop offset="25%" stopColor="rgba(180, 83, 9, 0.28)" />
            <stop offset="50%" stopColor="rgba(180, 83, 9, 0.07)" />
            <stop offset="75%" stopColor="rgba(180, 83, 9, 0.28)" />
            <stop offset="100%" stopColor="rgba(180, 83, 9, 0.06)" />
          </linearGradient>

          <linearGradient id="lpArcSlate" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="rgba(20, 20, 19, 0.05)" />
            <stop offset="50%" stopColor="rgba(20, 20, 19, 0.14)" />
            <stop offset="100%" stopColor="rgba(20, 20, 19, 0.05)" />
          </linearGradient>
        </defs>

        {/* Concentric Control Tower Azimuth Rings */}
        <g>
          <circle
            cx="720"
            cy="230"
            r="245"
            fill="none"
            stroke="rgba(13, 107, 99, 0.12)"
            strokeWidth="1"
            strokeDasharray="3 6"
          />
          <circle
            cx="720"
            cy="230"
            r="368"
            fill="none"
            stroke="url(#lpHeroRingFade)"
            strokeWidth="1.25"
          />
          <circle
            cx="720"
            cy="230"
            r="505"
            fill="none"
            stroke="rgba(13, 107, 99, 0.11)"
            strokeWidth="1"
            strokeDasharray="6 8"
          />
          <circle
            cx="720"
            cy="230"
            r="650"
            fill="none"
            stroke="rgba(20, 20, 19, 0.07)"
            strokeWidth="1"
          />

          {COMPASS_TICKS.map((tick, idx) => (
            <line
              key={idx}
              x1={tick.x1}
              y1={tick.y1}
              x2={tick.x2}
              y2={tick.y2}
              stroke={tick.major ? "rgba(13, 107, 99, 0.24)" : "rgba(13, 107, 99, 0.12)"}
              strokeWidth={tick.major ? "1.2" : "0.9"}
            />
          ))}
        </g>

        {/* Geodesic Lateral Framing Arcs */}
        <path
          d="M 110 -20 Q 320 265 110 580"
          fill="none"
          stroke="rgba(13, 107, 99, 0.11)"
          strokeWidth="1"
        />
        <path
          d="M 1330 -20 Q 1120 265 1330 580"
          fill="none"
          stroke="rgba(13, 107, 99, 0.11)"
          strokeWidth="1"
        />

        {/* Sweeping Multimodal Freight Corridors + Traveling Signal Pulses */}
        {CORRIDOR_PATHS.map((path) => {
          const strokeUrl =
            path.tone === "teal"
              ? "url(#lpArcTeal)"
              : path.tone === "amber"
                ? "url(#lpArcAmber)"
                : "url(#lpArcSlate)";
          const pulseColor =
            path.tone === "amber"
              ? "#c26a1b"
              : path.tone === "slate"
                ? "#4c5654"
                : "#0d6b63";
          const pulseHalo =
            path.tone === "amber"
              ? "rgba(194, 106, 27, 0.2)"
              : "rgba(13, 107, 99, 0.2)";

          return (
            <g key={path.id}>
              <path
                d={path.d}
                fill="none"
                stroke={strokeUrl}
                strokeWidth={path.width}
                strokeLinecap="round"
              />
              <circle r="3.2" fill={pulseColor} className="lp-hero-pulse">
                <animateMotion
                  dur={path.dur}
                  begin={path.begin}
                  repeatCount="indefinite"
                  path={path.d}
                />
              </circle>
              <circle r="8.5" fill={pulseHalo} className="lp-hero-pulse">
                <animateMotion
                  dur={path.dur}
                  begin={path.begin}
                  repeatCount="indefinite"
                  path={path.d}
                />
              </circle>
            </g>
          );
        })}

        {/* Perimeter Intermodal Hub Waypoints */}
        {HUB_NODES.map((node, idx) => {
          const fill =
            node.tone === "amber"
              ? "#c26a1b"
              : node.tone === "slate"
                ? "#525c5a"
                : "#0d6b63";
          const halo =
            node.tone === "amber"
              ? "rgba(194, 106, 27, 0.16)"
              : node.tone === "slate"
                ? "rgba(82, 92, 90, 0.12)"
                : "rgba(13, 107, 99, 0.16)";

          return (
            <g key={idx} transform={`translate(${node.x}, ${node.y})`}>
              <circle r={node.r * 2.5} fill={halo} />
              <circle
                r={node.r}
                fill={fill}
                stroke="#f8f7f4"
                strokeWidth="1.5"
              />
            </g>
          );
        })}
      </svg>

      {/* Atmospheric gradient & center alabaster reading veil */}
      <div className="lp-hero-halo" />
      <div className="lp-hero-center-veil" />
    </div>
  );
}
