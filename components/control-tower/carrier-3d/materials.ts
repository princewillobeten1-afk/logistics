import * as THREE from "three";

export interface CarrierMaterialPalette {
  textures: THREE.Texture[];
  materials: THREE.Material[];
  cabPaint: THREE.MeshPhysicalMaterial;
  cabSecondary: THREE.MeshStandardMaterial;
  fuselagePaint: THREE.MeshPhysicalMaterial;
  marineHull: THREE.MeshPhysicalMaterial;
  marineBootTop: THREE.MeshStandardMaterial;
  marineDeck: THREE.MeshStandardMaterial;
  superstructureWhite: THREE.MeshStandardMaterial;
  trailerBody: THREE.MeshPhysicalMaterial;
  containerTeal: THREE.MeshStandardMaterial;
  containerSlate: THREE.MeshStandardMaterial;
  containerRust: THREE.MeshStandardMaterial;
  containerIvory: THREE.MeshStandardMaterial;
  brushedChrome: THREE.MeshPhysicalMaterial;
  darkSteel: THREE.MeshStandardMaterial;
  tireRubber: THREE.MeshStandardMaterial;
  alloyRim: THREE.MeshStandardMaterial;
  tintedGlass: THREE.MeshPhysicalMaterial;
  headlightGlow: THREE.MeshStandardMaterial;
  taillightGlow: THREE.MeshStandardMaterial;
  amberBeacon: THREE.MeshStandardMaterial;
  navGreenGlow: THREE.MeshStandardMaterial;
  railSteel: THREE.MeshStandardMaterial;
  railTimber: THREE.MeshStandardMaterial;
  asphaltStage: THREE.MeshStandardMaterial;
  runwayStage: THREE.MeshStandardMaterial;
  waterSurface: THREE.MeshPhysicalMaterial;
  ballastStage: THREE.MeshStandardMaterial;
  contactShadowMat: THREE.MeshBasicMaterial;
  dispose: () => void;
}

function makeCorrugatedTexture(
  baseHex: string,
  ribHex: string,
  stripeHex: string | null,
  maxAnisotropy: number,
  verticalRibs = true,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (verticalRibs) {
    const step = 16;
    for (let x = 0; x < canvas.width; x += step) {
      const grad = ctx.createLinearGradient(x, 0, x + step, 0);
      grad.addColorStop(0, "rgba(255,255,255,0.09)");
      grad.addColorStop(0.35, "rgba(255,255,255,0.0)");
      grad.addColorStop(0.6, ribHex);
      grad.addColorStop(1, "rgba(0,0,0,0.0)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, 0, step, canvas.height);
    }
  } else {
    const step = 18;
    for (let y = 0; y < canvas.height; y += step) {
      ctx.fillStyle = ribHex;
      ctx.fillRect(0, y, canvas.width, 5);
    }
  }

  // Subtle corner frame border and fleet livery band
  ctx.strokeStyle = "rgba(0, 0, 0, 0.22)";
  ctx.lineWidth = 10;
  ctx.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);

  if (stripeHex) {
    ctx.fillStyle = stripeHex;
    ctx.fillRect(0, canvas.height * 0.62, canvas.width, 22);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, canvas.height * 0.62, canvas.width, 3);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeAsphaltTexture(
  isRunway: boolean,
  maxAnisotropy: number,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = isRunway ? "#1d2428" : "#1b2023";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Fine mineral grain
  for (let i = 0; i < 4200; i += 1) {
    const x = (i * 73) % canvas.width;
    const y = (i * 137) % canvas.height;
    const v = 24 + ((i * 29) % 24);
    ctx.fillStyle = `rgb(${v},${v + 2},${v + 4})`;
    ctx.fillRect(x, y, 2, 2);
  }

  if (isRunway) {
    // Runway centerline dashes & edge lines
    ctx.fillStyle = "rgba(232, 238, 240, 0.55)";
    ctx.fillRect(0, 14, canvas.width, 4);
    ctx.fillRect(0, canvas.height - 18, canvas.width, 4);
    for (let x = 24; x < canvas.width; x += 96) {
      ctx.fillRect(x, canvas.height / 2 - 4, 52, 8);
    }
  } else {
    // Highway shoulder lines & amber dashed centerline
    ctx.fillStyle = "rgba(226, 232, 236, 0.42)";
    ctx.fillRect(0, 18, canvas.width, 3);
    ctx.fillRect(0, canvas.height - 21, canvas.width, 3);
    ctx.fillStyle = "rgba(245, 179, 66, 0.68)";
    for (let x = 18; x < canvas.width; x += 84) {
      ctx.fillRect(x, canvas.height / 2 - 3, 44, 6);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeBallastTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#202423";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (let i = 0; i < 6500; i += 1) {
    const x = (i * 97) % canvas.width;
    const y = (i * 53) % canvas.height;
    const v = 30 + ((i * 19) % 34);
    ctx.fillStyle = `rgb(${v},${v - 1},${v - 2})`;
    ctx.fillRect(x, y, 3, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeOceanBumpTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, 256, 256);

  for (let y = 0; y < 256; y += 2) {
    for (let x = 0; x < 256; x += 2) {
      const wave =
        Math.sin(x * 0.12 + y * 0.05) * 32 +
        Math.cos(x * 0.05 - y * 0.14) * 24 +
        Math.sin((x + y) * 0.19) * 14;
      const g = Math.max(0, Math.min(255, Math.round(128 + wave)));
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(x, y, 2, 2);
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.anisotropy = maxAnisotropy;
  tex.needsUpdate = true;
  return tex;
}

function makeContactShadowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;

  const grad = ctx.createRadialGradient(128, 64, 14, 128, 64, 120);
  grad.addColorStop(0, "rgba(0, 0, 0, 0.72)");
  grad.addColorStop(0.52, "rgba(0, 0, 0, 0.34)");
  grad.addColorStop(1, "rgba(0, 0, 0, 0.0)");

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createCarrierMaterials(
  maxAnisotropy: number,
  isSoftwareGl: boolean,
): CarrierMaterialPalette {
  const textures: THREE.Texture[] = [];
  const materials: THREE.Material[] = [];

  const trackTex = <T extends THREE.Texture>(t: T): T => {
    textures.push(t);
    return t;
  };
  const trackMat = <T extends THREE.Material>(m: T): T => {
    materials.push(m);
    return m;
  };

  const trailerTex = trackTex(
    makeCorrugatedTexture("#e2e8ea", "rgba(0,0,0,0.14)", "#0f766e", maxAnisotropy, true),
  );
  const containerTealTex = trackTex(
    makeCorrugatedTexture("#0f766e", "rgba(0,0,0,0.22)", null, maxAnisotropy, true),
  );
  const containerSlateTex = trackTex(
    makeCorrugatedTexture("#274156", "rgba(0,0,0,0.24)", null, maxAnisotropy, true),
  );
  const containerRustTex = trackTex(
    makeCorrugatedTexture("#9e472a", "rgba(0,0,0,0.24)", null, maxAnisotropy, true),
  );
  const containerIvoryTex = trackTex(
    makeCorrugatedTexture("#cfd8dc", "rgba(0,0,0,0.16)", "#0d6b63", maxAnisotropy, true),
  );
  const roadTex = trackTex(makeAsphaltTexture(false, maxAnisotropy));
  const runwayTex = trackTex(makeAsphaltTexture(true, maxAnisotropy));
  const ballastTex = trackTex(makeBallastTexture(maxAnisotropy));
  const oceanBumpTex = trackTex(makeOceanBumpTexture(maxAnisotropy));
  const shadowTex = trackTex(makeContactShadowTexture());

  const cabPaint = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x0f766e,
      metalness: 0.62,
      roughness: 0.24,
      clearcoat: 1.0,
      clearcoatRoughness: 0.1,
      envMapIntensity: 1.25,
    }),
  );

  const cabSecondary = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x1d2729,
      metalness: 0.35,
      roughness: 0.56,
    }),
  );

  const fuselagePaint = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xeaf0f2,
      metalness: 0.28,
      roughness: 0.22,
      clearcoat: 0.95,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.2,
    }),
  );

  const marineHull = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x1a2630,
      metalness: 0.34,
      roughness: 0.44,
      clearcoat: 0.35,
      clearcoatRoughness: 0.32,
    }),
  );

  const marineBootTop = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x993524,
      metalness: 0.14,
      roughness: 0.62,
    }),
  );

  const marineDeck = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x2c3c3a,
      metalness: 0.2,
      roughness: 0.72,
    }),
  );

  const superstructureWhite = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xe5ecee,
      metalness: 0.12,
      roughness: 0.42,
    }),
  );

  const trailerBody = trackMat(
    new THREE.MeshPhysicalMaterial({
      map: trailerTex,
      metalness: 0.38,
      roughness: 0.34,
      clearcoat: 0.35,
      clearcoatRoughness: 0.28,
    }),
  );

  const containerTeal = trackMat(
    new THREE.MeshStandardMaterial({
      map: containerTealTex,
      metalness: 0.32,
      roughness: 0.52,
    }),
  );

  const containerSlate = trackMat(
    new THREE.MeshStandardMaterial({
      map: containerSlateTex,
      metalness: 0.32,
      roughness: 0.54,
    }),
  );

  const containerRust = trackMat(
    new THREE.MeshStandardMaterial({
      map: containerRustTex,
      metalness: 0.28,
      roughness: 0.58,
    }),
  );

  const containerIvory = trackMat(
    new THREE.MeshStandardMaterial({
      map: containerIvoryTex,
      metalness: 0.3,
      roughness: 0.48,
    }),
  );

  const brushedChrome = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xdce4e8,
      metalness: 0.94,
      roughness: 0.16,
      anisotropy: 0.8,
      envMapIntensity: 1.4,
    }),
  );

  const darkSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x22282a,
      metalness: 0.78,
      roughness: 0.46,
    }),
  );

  const tireRubber = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x141718,
      metalness: 0.04,
      roughness: 0.88,
    }),
  );

  const alloyRim = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0xc2ccd1,
      metalness: 0.9,
      roughness: 0.2,
      envMapIntensity: 1.3,
    }),
  );

  const tintedGlass = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x0b1a1f,
      metalness: 0.15,
      roughness: 0.06,
      clearcoat: 1.0,
      clearcoatRoughness: 0.05,
      transmission: isSoftwareGl ? 0 : 0.35,
      transparent: true,
      opacity: isSoftwareGl ? 0.82 : 0.92,
      ior: 1.52,
      envMapIntensity: 1.45,
    }),
  );

  const headlightGlow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xfff8e6,
      emissive: 0xffe4a8,
      emissiveIntensity: 1.75,
      roughness: 0.15,
      metalness: 0.1,
    }),
  );

  const taillightGlow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xdc2626,
      emissiveIntensity: 1.4,
      roughness: 0.2,
    }),
  );

  const amberBeacon = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 1.35,
      roughness: 0.22,
    }),
  );

  const navGreenGlow = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x34d399,
      emissive: 0x10b981,
      emissiveIntensity: 1.4,
      roughness: 0.2,
    }),
  );

  const railSteel = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x9aa6ad,
      metalness: 0.88,
      roughness: 0.24,
    }),
  );

  const railTimber = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0x3a2f28,
      metalness: 0.05,
      roughness: 0.86,
    }),
  );

  const asphaltStage = trackMat(
    new THREE.MeshStandardMaterial({
      map: roadTex,
      roughness: 0.82,
      metalness: 0.05,
    }),
  );

  const runwayStage = trackMat(
    new THREE.MeshStandardMaterial({
      map: runwayTex,
      roughness: 0.78,
      metalness: 0.08,
    }),
  );

  const waterSurface = trackMat(
    new THREE.MeshPhysicalMaterial({
      color: 0x0b2a34,
      metalness: 0.12,
      roughness: 0.18,
      bumpMap: oceanBumpTex,
      bumpScale: 0.035,
      clearcoat: 0.85,
      clearcoatRoughness: 0.14,
      transparent: true,
      opacity: 0.9,
      envMapIntensity: 1.35,
    }),
  );

  const ballastStage = trackMat(
    new THREE.MeshStandardMaterial({
      map: ballastTex,
      roughness: 0.92,
      metalness: 0.04,
    }),
  );

  const contactShadowMat = trackMat(
    new THREE.MeshBasicMaterial({
      map: shadowTex,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );

  return {
    textures,
    materials,
    cabPaint,
    cabSecondary,
    fuselagePaint,
    marineHull,
    marineBootTop,
    marineDeck,
    superstructureWhite,
    trailerBody,
    containerTeal,
    containerSlate,
    containerRust,
    containerIvory,
    brushedChrome,
    darkSteel,
    tireRubber,
    alloyRim,
    tintedGlass,
    headlightGlow,
    taillightGlow,
    amberBeacon,
    navGreenGlow,
    railSteel,
    railTimber,
    asphaltStage,
    runwayStage,
    waterSurface,
    ballastStage,
    contactShadowMat,
    dispose: () => {
      textures.forEach((t) => t.dispose());
      materials.forEach((m) => m.dispose());
    },
  };
}
