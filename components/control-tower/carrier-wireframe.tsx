"use client";

type TransportMode = "SEA" | "AIR" | "ROAD" | "RAIL";

export function CarrierWireframe({ mode }: { mode: TransportMode }) {
  if (mode === "AIR") {
    return (
      <svg
        viewBox="0 0 360 128"
        className="ct-wireframe"
        role="img"
        aria-label="Wireframe cargo freighter aircraft illustration"
      >
        <defs>
          <linearGradient id="wf-fade-air" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="80%" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Tail fin */}
        <polygon
          points="72,64 46,24 68,24 98,58"
          fill="url(#wf-fade-air)"
          stroke="currentColor"
          strokeOpacity="0.34"
          strokeWidth="1"
        />
        <line x1="68" y1="24" x2="84" y2="60" stroke="currentColor" strokeOpacity="0.22" strokeWidth="0.9" />
        {/* Main fuselage */}
        <polygon
          points="66,68 106,54 252,54 294,68 278,82 88,82"
          fill="url(#wf-fade-air)"
          stroke="currentColor"
          strokeOpacity="0.42"
          strokeWidth="1.15"
        />
        {/* Cockpit facets */}
        <polyline points="252,54 274,62 294,68" fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1" />
        <polyline points="258,64 274,62 278,82" fill="none" stroke="currentColor" strokeOpacity="0.28" strokeWidth="0.9" />
        {/* Fuselage wireframe ribs */}
        {[110, 140, 170, 200, 230].map((x) => (
          <g key={x}>
            <line x1={x} y1="54" x2={x - 6} y2="82" stroke="currentColor" strokeOpacity="0.2" strokeWidth="0.85" />
            <line x1={x} y1="54" x2={x + 24} y2="82" stroke="currentColor" strokeOpacity="0.14" strokeWidth="0.75" />
          </g>
        ))}
        {/* Cargo nose/mid doors */}
        <rect x="206" y="59" width="24" height="12" rx="1.5" fill="none" stroke="currentColor" strokeOpacity="0.32" strokeWidth="0.9" />
        {/* Near swept wing */}
        <polygon
          points="154,74 202,74 128,116 106,112"
          fill="url(#wf-fade-air)"
          stroke="currentColor"
          strokeOpacity="0.44"
          strokeWidth="1.1"
        />
        <line x1="176" y1="74" x2="118" y2="114" stroke="currentColor" strokeOpacity="0.24" strokeWidth="0.85" />
        {/* Far swept wing */}
        <polygon
          points="178,54 208,54 156,28 142,30"
          fill="url(#wf-fade-air)"
          stroke="currentColor"
          strokeOpacity="0.26"
          strokeWidth="0.95"
        />
        {/* Turbine pods */}
        <ellipse cx="164" cy="96" rx="12" ry="6" fill="url(#wf-fade-air)" stroke="currentColor" strokeOpacity="0.42" strokeWidth="1" />
        <ellipse cx="136" cy="108" rx="9" ry="4.5" fill="url(#wf-fade-air)" stroke="currentColor" strokeOpacity="0.32" strokeWidth="0.9" />
        {/* Ground shadow line */}
        <line x1="36" y1="120" x2="324" y2="120" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" strokeDasharray="3 3" />
      </svg>
    );
  }

  if (mode === "ROAD") {
    return (
      <svg
        viewBox="0 0 360 128"
        className="ct-wireframe"
        role="img"
        aria-label="Wireframe heavy freight truck illustration"
      >
        <defs>
          <linearGradient id="wf-fade-road" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="85%" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Trailer side & top isometric planes */}
        <polygon
          points="42,38 206,24 228,36 228,92 42,96"
          fill="url(#wf-fade-road)"
          stroke="currentColor"
          strokeOpacity="0.4"
          strokeWidth="1.15"
        />
        <polyline points="42,38 66,50 228,36" fill="none" stroke="currentColor" strokeOpacity="0.26" strokeWidth="0.9" />
        <line x1="66" y1="50" x2="66" y2="95" stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.9" />
        {/* Container ribs */}
        {[94, 124, 154, 184, 210].map((x) => (
          <g key={x}>
            <line x1={x} y1="47" x2={x} y2="93" stroke="currentColor" strokeOpacity="0.2" strokeWidth="0.85" />
            <line x1={x} y1="47" x2={x - 24} y2="94" stroke="currentColor" strokeOpacity="0.12" strokeWidth="0.75" />
          </g>
        ))}
        {/* Cab */}
        <polygon
          points="232,52 282,48 308,68 312,96 232,96"
          fill="url(#wf-fade-road)"
          stroke="currentColor"
          strokeOpacity="0.46"
          strokeWidth="1.2"
        />
        <polygon
          points="254,54 282,52 298,66 254,68"
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.34"
          strokeWidth="0.95"
        />
        <line x1="252" y1="50" x2="252" y2="96" stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.9" />
        {/* Grille lines */}
        <line x1="292" y1="74" x2="310" y2="74" stroke="currentColor" strokeOpacity="0.28" strokeWidth="0.9" />
        <line x1="292" y1="80" x2="310" y2="80" stroke="currentColor" strokeOpacity="0.28" strokeWidth="0.9" />
        {/* Wheels */}
        {[82, 114, 198, 280].map((cx) => (
          <g key={cx}>
            <circle cx={cx} cy="98" r="12" fill="var(--surface, #ffffff)" stroke="currentColor" strokeOpacity="0.48" strokeWidth="1.25" />
            <circle cx={cx} cy="98" r="5" fill="none" stroke="currentColor" strokeOpacity="0.32" strokeWidth="0.9" />
          </g>
        ))}
        <line x1="24" y1="112" x2="334" y2="112" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1" />
      </svg>
    );
  }

  if (mode === "RAIL") {
    return (
      <svg
        viewBox="0 0 360 128"
        className="ct-wireframe"
        role="img"
        aria-label="Wireframe intermodal freight rail illustration"
      >
        <defs>
          <linearGradient id="wf-fade-rail" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="85%" stopColor="currentColor" stopOpacity="0.06" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Intermodal flatcar & container */}
        <polygon
          points="36,42 184,42 184,90 36,90"
          fill="url(#wf-fade-rail)"
          stroke="currentColor"
          strokeOpacity="0.36"
          strokeWidth="1.1"
        />
        {[66, 96, 126, 156].map((x) => (
          <line key={x} x1={x} y1="42" x2={x} y2="90" stroke="currentColor" strokeOpacity="0.2" strokeWidth="0.85" />
        ))}
        {/* Locomotive */}
        <polygon
          points="194,38 286,38 314,68 314,94 194,94"
          fill="url(#wf-fade-rail)"
          stroke="currentColor"
          strokeOpacity="0.46"
          strokeWidth="1.2"
        />
        <polygon points="258,42 284,42 300,62 258,62" fill="none" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.95" />
        <line x1="226" y1="38" x2="226" y2="94" stroke="currentColor" strokeOpacity="0.22" strokeWidth="0.9" />
        <line x1="194" y1="68" x2="314" y2="68" stroke="currentColor" strokeOpacity="0.24" strokeWidth="0.9" />
        {[60, 84, 144, 168, 214, 240, 274, 298].map((cx) => (
          <circle key={cx} cx={cx} cy="98" r="8" fill="var(--surface, #ffffff)" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.15" />
        ))}
        <line x1="20" y1="108" x2="340" y2="108" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.2" />
      </svg>
    );
  }

  // Default SEA container vessel — triangulated polygon CAD wireframe matching the control tower reference
  return (
    <svg
      viewBox="0 0 360 128"
      className="ct-wireframe"
      role="img"
      aria-label="Wireframe ocean container vessel illustration"
    >
      <defs>
        <linearGradient id="wf-fade-sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="72%" stopColor="currentColor" stopOpacity="0.08" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* Container stacks on main deck */}
      <g fill="url(#wf-fade-sea)" stroke="currentColor" strokeOpacity="0.3" strokeWidth="0.95">
        <polygon points="86,62 114,50 114,76 86,86" />
        <polygon points="114,50 144,44 144,74 114,76" />
        <polygon points="144,44 176,38 176,74 144,74" />
        <polygon points="176,38 212,34 212,74 176,74" />
        <polygon points="104,38 134,32 134,50 104,54" />
        <polygon points="134,32 168,28 168,44 134,44" />
        <polygon points="168,28 206,24 206,38 168,38" />
      </g>

      {/* Container mesh cross-ribs */}
      <g stroke="currentColor" strokeOpacity="0.18" strokeWidth="0.8">
        <line x1="98" y1="56" x2="98" y2="82" />
        <line x1="128" y1="46" x2="128" y2="75" />
        <line x1="160" y1="40" x2="160" y2="74" />
        <line x1="192" y1="36" x2="192" y2="74" />
        <line x1="104" y1="44" x2="206" y2="32" />
        <line x1="86" y1="74" x2="212" y2="62" />
      </g>

      {/* Bridge superstructure & radar mast */}
      <g fill="url(#wf-fade-sea)" stroke="currentColor" strokeOpacity="0.38" strokeWidth="1">
        <polygon points="214,22 256,22 268,36 268,74 214,74" />
        <polygon points="222,10 248,10 256,22 214,22" />
        <line x1="236" y1="2" x2="236" y2="10" />
        <line x1="226" y1="6" x2="246" y2="6" />
        <line x1="214" y1="36" x2="268" y2="36" strokeOpacity="0.22" />
        <line x1="214" y1="52" x2="268" y2="52" strokeOpacity="0.22" />
      </g>

      {/* Triangulated vessel bow & hull */}
      <polygon
        points="40,72 86,84 274,74 302,118 58,118"
        fill="url(#wf-fade-sea)"
        stroke="currentColor"
        strokeOpacity="0.46"
        strokeWidth="1.2"
      />
      <g stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.9">
        <line x1="40" y1="72" x2="96" y2="118" />
        <line x1="86" y1="84" x2="58" y2="118" />
        <line x1="86" y1="84" x2="132" y2="118" />
        <line x1="138" y1="80" x2="96" y2="118" />
        <line x1="138" y1="80" x2="178" y2="118" />
        <line x1="196" y1="78" x2="178" y2="118" />
        <line x1="196" y1="78" x2="234" y2="118" />
        <line x1="248" y1="75" x2="234" y2="118" />
        <line x1="248" y1="75" x2="284" y2="118" />
        <line x1="274" y1="74" x2="284" y2="118" />
      </g>

      {/* Waterline fade */}
      <line x1="24" y1="120" x2="334" y2="120" stroke="currentColor" strokeOpacity="0.16" strokeWidth="1" strokeDasharray="4 3" />
    </svg>
  );
}
