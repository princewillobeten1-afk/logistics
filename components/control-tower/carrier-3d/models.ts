import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { CarrierMaterialPalette } from "./materials";

export type TransportMode = "SEA" | "AIR" | "ROAD" | "RAIL";

export interface BuiltCarrierModel {
  group: THREE.Group;
  targetY: number;
  cameraDistance: number;
  animate: (elapsed: number, delta: number) => void;
  dispose: () => void;
}

function trackGeo(
  geometries: THREE.BufferGeometry[],
  geo: THREE.BufferGeometry,
): THREE.BufferGeometry {
  geometries.push(geo);
  return geo;
}

function addContactShadow(
  parent: THREE.Group,
  geometries: THREE.BufferGeometry[],
  mat: THREE.Material,
  width: number,
  depth: number,
  y = 0.015,
): THREE.Mesh {
  const geo = trackGeo(geometries, new THREE.PlaneGeometry(width, depth));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = 1;
  parent.add(mesh);
  return mesh;
}

function buildTruckWheel(
  radius: number,
  width: number,
  mats: CarrierMaterialPalette,
  geometries: THREE.BufferGeometry[],
  dual = false,
): THREE.Group {
  const wheelGroup = new THREE.Group();
  const offsets = dual ? [-width * 0.56, width * 0.56] : [0];

  for (const zOff of offsets) {
    const tireGeo = trackGeo(
      geometries,
      new THREE.CylinderGeometry(radius, radius, width * 0.9, 28),
    );
    tireGeo.rotateX(Math.PI / 2);
    const tire = new THREE.Mesh(tireGeo, mats.tireRubber);
    tire.position.z = zOff;
    tire.castShadow = true;
    tire.receiveShadow = true;
    wheelGroup.add(tire);

    const rimGeo = trackGeo(
      geometries,
      new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, width * 0.93, 20),
    );
    rimGeo.rotateX(Math.PI / 2);
    const rim = new THREE.Mesh(rimGeo, mats.alloyRim);
    rim.position.z = zOff;
    wheelGroup.add(rim);

    const hubGeo = trackGeo(
      geometries,
      new THREE.CylinderGeometry(radius * 0.22, radius * 0.26, width * 0.98, 14),
    );
    hubGeo.rotateX(Math.PI / 2);
    const hub = new THREE.Mesh(hubGeo, mats.darkSteel);
    hub.position.z = zOff;
    wheelGroup.add(hub);
  }

  return wheelGroup;
}

export function buildRoadTruck(mats: CarrierMaterialPalette): BuiltCarrierModel {
  const geometries: THREE.BufferGeometry[] = [];
  const root = new THREE.Group();
  const vehicle = new THREE.Group();
  root.add(vehicle);

  // Highway asphalt plinth
  const roadGeo = trackGeo(geometries, new THREE.BoxGeometry(8.6, 0.08, 3.3));
  const road = new THREE.Mesh(roadGeo, mats.asphaltStage);
  road.position.y = -0.04;
  road.receiveShadow = true;
  root.add(road);

  addContactShadow(root, geometries, mats.contactShadowMat, 7.2, 2.5, 0.008);

  // Main chassis frame rails (run from trailer rear to tractor front)
  const frameGeo = trackGeo(geometries, new THREE.BoxGeometry(6.4, 0.14, 0.72));
  const frame = new THREE.Mesh(frameGeo, mats.darkSteel);
  frame.position.set(-0.25, 0.56, 0);
  frame.castShadow = true;
  vehicle.add(frame);

  // 53ft Ribbed Cargo Trailer
  const trailerGeo = trackGeo(
    geometries,
    new RoundedBoxGeometry(4.45, 1.72, 1.72, 3, 0.04),
  );
  const trailer = new THREE.Mesh(trailerGeo, mats.trailerBody);
  trailer.position.set(-1.35, 1.56, 0);
  trailer.castShadow = true;
  trailer.receiveShadow = true;
  vehicle.add(trailer);

  // Trailer aerodynamic side skirts & stainless rear door frame
  const skirtGeo = trackGeo(geometries, new THREE.BoxGeometry(2.6, 0.34, 0.04));
  for (const side of [-1, 1]) {
    const skirt = new THREE.Mesh(skirtGeo, mats.cabSecondary);
    skirt.position.set(-0.95, 0.54, side * 0.83);
    skirt.castShadow = true;
    vehicle.add(skirt);
  }

  const rearFrameGeo = trackGeo(geometries, new THREE.BoxGeometry(0.06, 1.66, 1.68));
  const rearFrame = new THREE.Mesh(rearFrameGeo, mats.brushedChrome);
  rearFrame.position.set(-3.56, 1.56, 0);
  vehicle.add(rearFrame);

  // Rear taillights
  const tailGeo = trackGeo(geometries, new THREE.BoxGeometry(0.06, 0.1, 0.24));
  for (const side of [-1, 1]) {
    const tail = new THREE.Mesh(tailGeo, mats.taillightGlow);
    tail.position.set(-3.59, 0.66, side * 0.62);
    vehicle.add(tail);
  }

  // Fifth wheel coupling plate & landing gear
  const fifthGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.36, 0.38, 0.1, 16));
  const fifth = new THREE.Mesh(fifthGeo, mats.darkSteel);
  fifth.position.set(0.75, 0.68, 0);
  vehicle.add(fifth);

  const legGeo = trackGeo(geometries, new THREE.BoxGeometry(0.09, 0.42, 0.09));
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(legGeo, mats.darkSteel);
    leg.position.set(0.02, 0.44, side * 0.56);
    vehicle.add(leg);
  }

  // Sculpted Aero Tractor Cab via ExtrudeGeometry
  const cabShape = new THREE.Shape();
  cabShape.moveTo(0.78, 0.64);
  cabShape.lineTo(2.96, 0.64);
  cabShape.lineTo(3.04, 0.78);
  cabShape.lineTo(3.0, 1.3);
  cabShape.lineTo(2.42, 1.46);
  cabShape.lineTo(2.08, 2.08);
  cabShape.lineTo(1.78, 2.28);
  cabShape.lineTo(0.84, 2.28);
  cabShape.lineTo(0.78, 1.98);
  cabShape.closePath();

  const cabGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(cabShape, {
      depth: 1.54,
      bevelEnabled: true,
      bevelThickness: 0.07,
      bevelSize: 0.06,
      bevelSegments: 3,
    }),
  );
  cabGeo.translate(0, 0, -0.77);
  const cab = new THREE.Mesh(cabGeo, mats.cabPaint);
  cab.castShadow = true;
  cab.receiveShadow = true;
  vehicle.add(cab);

  // Rooftop Aero Fairing Deflector
  const fairingShape = new THREE.Shape();
  fairingShape.moveTo(0.84, 2.28);
  fairingShape.lineTo(1.66, 2.28);
  fairingShape.lineTo(0.92, 2.5);
  fairingShape.lineTo(0.84, 2.5);
  fairingShape.closePath();
  const fairingGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(fairingShape, {
      depth: 1.38,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 2,
    }),
  );
  fairingGeo.translate(0, 0, -0.69);
  const fairing = new THREE.Mesh(fairingGeo, mats.cabPaint);
  fairing.castShadow = true;
  vehicle.add(fairing);

  // Dark Tinted Wraparound Windshield & Side Windows
  const windGeo = trackGeo(geometries, new THREE.BoxGeometry(0.12, 0.56, 1.42));
  const wind = new THREE.Mesh(windGeo, mats.tintedGlass);
  wind.position.set(2.21, 1.78, 0);
  wind.rotation.z = 0.52;
  vehicle.add(wind);

  const sideWinGeo = trackGeo(geometries, new THREE.BoxGeometry(0.56, 0.44, 1.7));
  const sideWin = new THREE.Mesh(sideWinGeo, mats.tintedGlass);
  sideWin.position.set(1.72, 1.84, 0);
  vehicle.add(sideWin);

  // Chrome Grille + Front Bumper + Headlights
  const grilleGeo = trackGeo(geometries, new RoundedBoxGeometry(0.12, 0.56, 1.04, 2, 0.02));
  const grille = new THREE.Mesh(grilleGeo, mats.brushedChrome);
  grille.position.set(3.04, 1.0, 0);
  vehicle.add(grille);

  const bumperGeo = trackGeo(geometries, new RoundedBoxGeometry(0.22, 0.24, 1.72, 2, 0.04));
  const bumper = new THREE.Mesh(bumperGeo, mats.brushedChrome);
  bumper.position.set(3.05, 0.54, 0);
  bumper.castShadow = true;
  vehicle.add(bumper);

  const headGeo = trackGeo(geometries, new RoundedBoxGeometry(0.08, 0.11, 0.24, 2, 0.02));
  for (const side of [-1, 1]) {
    const headlight = new THREE.Mesh(headGeo, mats.headlightGlow);
    headlight.position.set(3.07, 0.84, side * 0.65);
    vehicle.add(headlight);

    const clearance = new THREE.Mesh(
      trackGeo(geometries, new THREE.BoxGeometry(0.08, 0.05, 0.08)),
      mats.amberBeacon,
    );
    clearance.position.set(1.78, 2.34, side * 0.52);
    vehicle.add(clearance);
  }

  // Twin Fuel Tanks & Exhaust Stacks
  const tankGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.2, 0.2, 1.05, 18));
  tankGeo.rotateZ(Math.PI / 2);
  const stackGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.045, 0.05, 1.68, 12));
  const mirrorArmGeo = trackGeo(geometries, new THREE.BoxGeometry(0.06, 0.28, 0.14));

  for (const side of [-1, 1]) {
    const tank = new THREE.Mesh(tankGeo, mats.brushedChrome);
    tank.position.set(1.52, 0.56, side * 0.78);
    tank.castShadow = true;
    vehicle.add(tank);

    const stack = new THREE.Mesh(stackGeo, mats.brushedChrome);
    stack.position.set(0.84, 1.72, side * 0.82);
    stack.castShadow = true;
    vehicle.add(stack);

    const mirror = new THREE.Mesh(mirrorArmGeo, mats.cabSecondary);
    mirror.position.set(2.04, 1.76, side * 0.94);
    vehicle.add(mirror);
  }

  // Wheels (Steer axle, Drive tandem, Trailer tandem)
  const wheels: THREE.Group[] = [];
  const wheelRadius = 0.34;
  const wheelPositions: Array<[number, number, boolean]> = [
    [2.52, 0.82, false],
    [2.52, -0.82, false],
    [1.18, 0.74, true],
    [1.18, -0.74, true],
    [0.44, 0.74, true],
    [0.44, -0.74, true],
    [-2.2, 0.74, true],
    [-2.2, -0.74, true],
    [-2.94, 0.74, true],
    [-2.94, -0.74, true],
  ];

  for (const [x, z, dual] of wheelPositions) {
    const w = buildTruckWheel(wheelRadius, 0.22, mats, geometries, dual);
    w.position.set(x, wheelRadius, z);
    vehicle.add(w);
    wheels.push(w);
  }

  return {
    group: root,
    targetY: 1.05,
    cameraDistance: 6.4,
    animate: (elapsed, delta) => {
      for (const w of wheels) {
        w.rotation.z -= delta * 3.4;
      }
      // Subtle road suspension micro-motion
      vehicle.position.y = Math.sin(elapsed * 5.2) * 0.008;
      vehicle.rotation.z = Math.sin(elapsed * 2.6) * 0.004;
    },
    dispose: () => {
      geometries.forEach((g) => g.dispose());
    },
  };
}

export function buildAirFreighter(mats: CarrierMaterialPalette): BuiltCarrierModel {
  const geometries: THREE.BufferGeometry[] = [];
  const root = new THREE.Group();
  const aircraft = new THREE.Group();
  aircraft.position.set(0, 1.12, 0);
  root.add(aircraft);

  // Runway tarmac strip below
  const runwayGeo = trackGeo(geometries, new THREE.BoxGeometry(8.8, 0.06, 3.6));
  const runway = new THREE.Mesh(runwayGeo, mats.runwayStage);
  runway.position.y = -0.03;
  runway.receiveShadow = true;
  root.add(runway);

  const shadowPlane = addContactShadow(root, geometries, mats.contactShadowMat, 6.2, 4.4, 0.012);
  shadowPlane.material = mats.contactShadowMat;

  // Sculpted Wide-Body Fuselage (LatheGeometry rotated to +X nose)
  const lathePts: THREE.Vector2[] = [
    new THREE.Vector2(0.0, -3.25),
    new THREE.Vector2(0.11, -2.95),
    new THREE.Vector2(0.32, -2.2),
    new THREE.Vector2(0.46, -1.45),
    new THREE.Vector2(0.47, 1.55),
    new THREE.Vector2(0.44, 2.05),
    new THREE.Vector2(0.34, 2.48),
    new THREE.Vector2(0.2, 2.82),
    new THREE.Vector2(0.07, 3.04),
    new THREE.Vector2(0.0, 3.1),
  ];
  const fuselageGeo = trackGeo(geometries, new THREE.LatheGeometry(lathePts, 36));
  fuselageGeo.rotateZ(-Math.PI / 2);
  fuselageGeo.scale(1, 1.06, 0.96);
  const fuselage = new THREE.Mesh(fuselageGeo, mats.fuselagePaint);
  fuselage.castShadow = true;
  fuselage.receiveShadow = true;
  aircraft.add(fuselage);

  // Belly fairing / cheatline livery band
  const bellyGeo = trackGeo(
    geometries,
    new THREE.CylinderGeometry(0.475, 0.475, 3.2, 28, 1, false, Math.PI * 0.65, Math.PI * 0.7),
  );
  bellyGeo.rotateZ(-Math.PI / 2);
  const belly = new THREE.Mesh(bellyGeo, mats.cabPaint);
  belly.position.y = -0.03;
  aircraft.add(belly);

  // Cockpit wraparound glass brow
  const cockpitGeo = trackGeo(
    geometries,
    new THREE.CylinderGeometry(0.36, 0.42, 0.42, 24, 1, false, -0.9, 1.8),
  );
  cockpitGeo.rotateZ(-Math.PI / 2);
  const cockpit = new THREE.Mesh(cockpitGeo, mats.tintedGlass);
  cockpit.position.set(2.38, 0.14, 0);
  cockpit.rotation.y = Math.PI / 2;
  aircraft.add(cockpit);

  // Main-deck side cargo door outline
  const cargoDoorGeo = trackGeo(geometries, new RoundedBoxGeometry(0.74, 0.34, 0.92, 2, 0.02));
  const cargoDoor = new THREE.Mesh(cargoDoorGeo, mats.cabSecondary);
  cargoDoor.position.set(1.22, 0.14, 0);
  aircraft.add(cargoDoor);

  // Swept Dihedral Main Wings + Blended Winglets
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.88, 0.0);
  wingShape.lineTo(-0.32, 0.0);
  wingShape.lineTo(-1.38, 2.75);
  wingShape.lineTo(-1.72, 2.75);
  wingShape.lineTo(-0.78, 0.0);
  wingShape.closePath();

  const wingGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(wingShape, {
      depth: 0.08,
      bevelEnabled: true,
      bevelThickness: 0.025,
      bevelSize: 0.03,
      bevelSegments: 2,
    }),
  );
  wingGeo.rotateX(Math.PI / 2);

  const wingletShape = new THREE.Shape();
  wingletShape.moveTo(0, 0);
  wingletShape.lineTo(-0.38, 0);
  wingletShape.lineTo(-0.56, 0.36);
  wingletShape.lineTo(-0.34, 0.36);
  wingletShape.closePath();
  const wingletGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(wingletShape, {
      depth: 0.03,
      bevelEnabled: true,
      bevelThickness: 0.01,
      bevelSize: 0.01,
      bevelSegments: 2,
    }),
  );

  for (const side of [-1, 1]) {
    const wingPivot = new THREE.Group();
    wingPivot.position.set(0.15, -0.1, side * 0.3);
    wingPivot.rotation.x = side * -0.075; // realistic upward dihedral

    const wingMesh = new THREE.Mesh(wingGeo, mats.fuselagePaint);
    if (side === -1) {
      wingMesh.scale.z = -1;
    }
    wingMesh.castShadow = true;
    wingMesh.receiveShadow = true;
    wingPivot.add(wingMesh);

    const winglet = new THREE.Mesh(wingletGeo, mats.cabPaint);
    winglet.position.set(-1.36, 0.02, side * 2.74);
    winglet.rotation.x = side * 0.25;
    wingPivot.add(winglet);

    // Wingtip navigation light
    const navLight = new THREE.Mesh(
      trackGeo(geometries, new THREE.SphereGeometry(0.04, 10, 10)),
      side > 0 ? mats.navGreenGlow : mats.taillightGlow,
    );
    navLight.position.set(-1.55, 0.04, side * 2.78);
    wingPivot.add(navLight);

    aircraft.add(wingPivot);
  }

  // Vertical Tail Fin + Horizontal Stabilizers
  const tailShape = new THREE.Shape();
  tailShape.moveTo(-2.15, 0.25);
  tailShape.lineTo(-3.08, 0.14);
  tailShape.lineTo(-3.55, 1.32);
  tailShape.lineTo(-3.12, 1.32);
  tailShape.closePath();

  const tailGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(tailShape, {
      depth: 0.06,
      bevelEnabled: true,
      bevelThickness: 0.02,
      bevelSize: 0.02,
      bevelSegments: 2,
    }),
  );
  tailGeo.translate(0, 0, -0.03);
  const vTail = new THREE.Mesh(tailGeo, mats.cabPaint);
  vTail.castShadow = true;
  aircraft.add(vTail);

  const hStabShape = new THREE.Shape();
  hStabShape.moveTo(-2.45, 0);
  hStabShape.lineTo(-3.02, 0);
  hStabShape.lineTo(-3.45, 1.05);
  hStabShape.lineTo(-3.2, 1.05);
  hStabShape.closePath();
  const hStabGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(hStabShape, {
      depth: 0.045,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 2,
    }),
  );
  hStabGeo.rotateX(Math.PI / 2);

  for (const side of [-1, 1]) {
    const hStab = new THREE.Mesh(hStabGeo, mats.fuselagePaint);
    hStab.position.set(0, 0.08, side * 0.16);
    if (side === -1) hStab.scale.z = -1;
    hStab.rotation.x = side * -0.06;
    hStab.castShadow = true;
    aircraft.add(hStab);
  }

  // Twin Under-Wing High-Bypass Turbofan Engines with Spinning Fan Rotors
  const engineSpinners: THREE.Group[] = [];
  const nacellePts = [
    new THREE.Vector2(0.18, -0.46),
    new THREE.Vector2(0.24, -0.25),
    new THREE.Vector2(0.26, 0.25),
    new THREE.Vector2(0.23, 0.45),
    new THREE.Vector2(0.2, 0.46),
  ];
  const nacelleGeo = trackGeo(geometries, new THREE.LatheGeometry(nacellePts, 28));
  nacelleGeo.rotateZ(-Math.PI / 2);

  const intakeRingGeo = trackGeo(geometries, new THREE.TorusGeometry(0.225, 0.025, 12, 28));
  intakeRingGeo.rotateY(Math.PI / 2);

  const bladeGeo = trackGeo(geometries, new THREE.BoxGeometry(0.02, 0.19, 0.055));
  const spinnerGeo = trackGeo(geometries, new THREE.ConeGeometry(0.075, 0.18, 16));
  spinnerGeo.rotateZ(-Math.PI / 2);

  const pylonGeo = trackGeo(geometries, new THREE.BoxGeometry(0.55, 0.22, 0.09));

  for (const side of [-1, 1]) {
    const pod = new THREE.Group();
    pod.position.set(0.32, -0.34, side * 1.18);

    const pylon = new THREE.Mesh(pylonGeo, mats.cabSecondary);
    pod.add(pylon);
    pylon.position.set(-0.08, 0.2, 0);

    const cowling = new THREE.Mesh(nacelleGeo, mats.fuselagePaint);
    cowling.castShadow = true;
    pod.add(cowling);

    const ring = new THREE.Mesh(intakeRingGeo, mats.brushedChrome);
    ring.position.x = 0.44;
    pod.add(ring);

    const rotor = new THREE.Group();
    rotor.position.x = 0.36;
    const cone = new THREE.Mesh(spinnerGeo, mats.darkSteel);
    cone.position.x = 0.06;
    rotor.add(cone);

    for (let b = 0; b < 10; b += 1) {
      const blade = new THREE.Mesh(bladeGeo, mats.alloyRim);
      const angle = (b / 10) * Math.PI * 2;
      blade.position.set(0, Math.cos(angle) * 0.11, Math.sin(angle) * 0.11);
      blade.rotation.x = angle;
      blade.rotation.y = 0.35;
      rotor.add(blade);
    }

    pod.add(rotor);
    engineSpinners.push(rotor);
    aircraft.add(pod);
  }

  // Tail beacon light
  const tailBeacon = new THREE.Mesh(
    trackGeo(geometries, new THREE.SphereGeometry(0.04, 10, 10)),
    mats.amberBeacon,
  );
  tailBeacon.position.set(-3.34, 1.35, 0);
  aircraft.add(tailBeacon);

  return {
    group: root,
    targetY: 1.05,
    cameraDistance: 6.6,
    animate: (elapsed, delta) => {
      for (const s of engineSpinners) {
        s.rotation.x += delta * 18;
      }
      aircraft.position.y = 1.12 + Math.sin(elapsed * 1.6) * 0.055;
      aircraft.rotation.z = Math.sin(elapsed * 1.1) * 0.032 + 0.025;
      aircraft.rotation.x = Math.cos(elapsed * 0.9) * 0.025;
    },
    dispose: () => {
      geometries.forEach((g) => g.dispose());
    },
  };
}

export function buildSeaVessel(mats: CarrierMaterialPalette): BuiltCarrierModel {
  const geometries: THREE.BufferGeometry[] = [];
  const root = new THREE.Group();
  const ship = new THREE.Group();
  root.add(ship);

  // Grounded ocean water sheet
  const waterGeo = trackGeo(geometries, new THREE.BoxGeometry(9.2, 0.12, 4.2));
  const water = new THREE.Mesh(waterGeo, mats.waterSurface);
  water.position.y = 0.04;
  water.receiveShadow = true;
  root.add(water);

  // Subtle wake foam chevron behind stern and bow
  const wakeMat = mats.superstructureWhite;
  const wakeGeo = trackGeo(geometries, new THREE.BoxGeometry(1.8, 0.015, 0.05));
  for (const side of [-1, 1]) {
    const wake = new THREE.Mesh(wakeGeo, wakeMat);
    wake.position.set(-3.7, 0.105, side * 0.56);
    wake.rotation.y = side * 0.22;
    root.add(wake);
  }

  // Sculpted Vessel Hull (Pointed bow at +X, transom stern at -X)
  const hullPlan = new THREE.Shape();
  hullPlan.moveTo(-3.2, -0.66);
  hullPlan.lineTo(1.75, -0.74);
  hullPlan.quadraticCurveTo(2.95, -0.62, 3.45, 0);
  hullPlan.quadraticCurveTo(2.95, 0.62, 1.75, 0.74);
  hullPlan.lineTo(-3.2, 0.66);
  hullPlan.closePath();

  const lowerHullGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(hullPlan, {
      depth: 0.24,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 2,
    }),
  );
  lowerHullGeo.rotateX(-Math.PI / 2);
  const lowerHull = new THREE.Mesh(lowerHullGeo, mats.marineBootTop);
  lowerHull.position.y = -0.02;
  ship.add(lowerHull);

  const upperHullGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(hullPlan, {
      depth: 0.44,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 2,
    }),
  );
  upperHullGeo.rotateX(-Math.PI / 2);
  const upperHull = new THREE.Mesh(upperHullGeo, mats.marineHull);
  upperHull.position.y = 0.24;
  upperHull.castShadow = true;
  upperHull.receiveShadow = true;
  ship.add(upperHull);

  // Main cargo deck surface
  const deckGeo = trackGeo(geometries, new THREE.BoxGeometry(5.1, 0.05, 1.32));
  const deck = new THREE.Mesh(deckGeo, mats.marineDeck);
  deck.position.set(-0.25, 0.7, 0);
  deck.receiveShadow = true;
  ship.add(deck);

  // Raised Forecastle Bow Deck & Anchor Hawse
  const bowDeckGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.18, 0.68, 0.24, 16));
  bowDeckGeo.scale(2.4, 1, 1.0);
  const bowDeck = new THREE.Mesh(bowDeckGeo, mats.marineHull);
  bowDeck.position.set(2.55, 0.72, 0);
  ship.add(bowDeck);

  // Stacked 40ft Corrugated ISO Shipping Containers (3 bays x 4 rows x 3 tiers)
  const containerMats = [
    mats.containerTeal,
    mats.containerSlate,
    mats.containerRust,
    mats.containerIvory,
  ];
  const containerGeo = trackGeo(
    geometries,
    new RoundedBoxGeometry(1.16, 0.26, 0.28, 2, 0.015),
  );
  const baysX = [-0.72, 0.52, 1.76];
  const rowsZ = [-0.45, -0.15, 0.15, 0.45];

  baysX.forEach((bx, bi) => {
    rowsZ.forEach((rz, ri) => {
      const tiers = bi === 2 && (ri === 0 || ri === 3) ? 2 : 3;
      for (let t = 0; t < tiers; t += 1) {
        const mat = containerMats[(bi * 3 + ri * 2 + t) % containerMats.length];
        const c = new THREE.Mesh(containerGeo, mat);
        c.position.set(bx, 0.86 + t * 0.27, rz);
        c.castShadow = true;
        c.receiveShadow = true;
        ship.add(c);
      }
    });
  });

  // Aft Bridge Superstructure Tower
  const bridgeTower = new THREE.Group();
  bridgeTower.position.set(-2.12, 0.72, 0);
  ship.add(bridgeTower);

  const towerBaseGeo = trackGeo(geometries, new RoundedBoxGeometry(0.72, 0.92, 1.18, 2, 0.03));
  const towerBase = new THREE.Mesh(towerBaseGeo, mats.superstructureWhite);
  towerBase.position.y = 0.46;
  towerBase.castShadow = true;
  towerBase.receiveShadow = true;
  bridgeTower.add(towerBase);

  // Wide Navigation Bridge Wing Deck
  const wingDeckGeo = trackGeo(geometries, new RoundedBoxGeometry(0.48, 0.24, 1.56, 2, 0.02));
  const wingDeck = new THREE.Mesh(wingDeckGeo, mats.superstructureWhite);
  wingDeck.position.set(0.06, 0.98, 0);
  wingDeck.castShadow = true;
  bridgeTower.add(wingDeck);

  // Bridge Windows
  const bridgeWinGeo = trackGeo(geometries, new THREE.BoxGeometry(0.5, 0.13, 1.24));
  const bridgeWin = new THREE.Mesh(bridgeWinGeo, mats.tintedGlass);
  bridgeWin.position.set(0.08, 0.99, 0);
  bridgeTower.add(bridgeWin);

  // Exhaust Smokestack Funnel
  const funnelGeo = trackGeo(geometries, new RoundedBoxGeometry(0.32, 0.56, 0.34, 2, 0.04));
  const funnel = new THREE.Mesh(funnelGeo, mats.cabPaint);
  funnel.position.set(-0.46, 0.48, 0);
  funnel.rotation.z = 0.12;
  funnel.castShadow = true;
  bridgeTower.add(funnel);

  // Radar Mast & Spinning Scanner
  const mastGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.025, 0.04, 0.48, 10));
  const mast = new THREE.Mesh(mastGeo, mats.brushedChrome);
  mast.position.set(0.06, 1.32, 0);
  bridgeTower.add(mast);

  const radarBar = new THREE.Mesh(
    trackGeo(geometries, new THREE.BoxGeometry(0.06, 0.04, 0.42)),
    mats.brushedChrome,
  );
  radarBar.position.set(0.06, 1.54, 0);
  bridgeTower.add(radarBar);

  const mastLight = new THREE.Mesh(
    trackGeo(geometries, new THREE.SphereGeometry(0.035, 10, 10)),
    mats.headlightGlow,
  );
  mastLight.position.set(0.06, 1.59, 0);
  bridgeTower.add(mastLight);

  return {
    group: root,
    targetY: 0.95,
    cameraDistance: 6.5,
    animate: (elapsed, delta) => {
      radarBar.rotation.y += delta * 4.2;
      ship.position.y = Math.sin(elapsed * 1.35) * 0.03;
      ship.rotation.x = Math.sin(elapsed * 1.1) * 0.022;
      ship.rotation.z = Math.cos(elapsed * 0.85) * 0.015;
    },
    dispose: () => {
      geometries.forEach((g) => g.dispose());
    },
  };
}

export function buildRailFreight(mats: CarrierMaterialPalette): BuiltCarrierModel {
  const geometries: THREE.BufferGeometry[] = [];
  const root = new THREE.Group();
  const train = new THREE.Group();
  root.add(train);

  // Crushed stone ballast bed
  const ballastGeo = trackGeo(geometries, new THREE.BoxGeometry(8.8, 0.1, 2.8));
  const ballast = new THREE.Mesh(ballastGeo, mats.ballastStage);
  ballast.position.y = -0.05;
  ballast.receiveShadow = true;
  root.add(ballast);

  // Timber crossties via InstancedMesh
  const tieCount = 22;
  const tieGeo = trackGeo(geometries, new THREE.BoxGeometry(0.16, 0.07, 1.36));
  const ties = new THREE.InstancedMesh(tieGeo, mats.railTimber, tieCount);
  ties.receiveShadow = true;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < tieCount; i += 1) {
    dummy.position.set(-4.1 + i * 0.39, 0.03, 0);
    dummy.updateMatrix();
    ties.setMatrixAt(i, dummy.matrix);
  }
  ties.instanceMatrix.needsUpdate = true;
  ties.computeBoundingSphere();
  root.add(ties);

  // Twin polished steel rails
  const railGeo = trackGeo(geometries, new THREE.BoxGeometry(8.8, 0.08, 0.06));
  for (const side of [-1, 1]) {
    const rail = new THREE.Mesh(railGeo, mats.railSteel);
    rail.position.set(0, 0.1, side * 0.44);
    rail.castShadow = true;
    root.add(rail);
  }

  addContactShadow(root, geometries, mats.contactShadowMat, 7.6, 2.0, 0.065);

  // Heavy Diesel-Electric Freight Locomotive (X: +0.25 to +3.35)
  const locoDeckGeo = trackGeo(geometries, new RoundedBoxGeometry(3.15, 0.22, 1.24, 2, 0.03));
  const locoDeck = new THREE.Mesh(locoDeckGeo, mats.darkSteel);
  locoDeck.position.set(1.82, 0.56, 0);
  locoDeck.castShadow = true;
  train.add(locoDeck);

  // Sculpted Safety Cab Nose (ExtrudeGeometry)
  const locoCabShape = new THREE.Shape();
  locoCabShape.moveTo(2.15, 0.66);
  locoCabShape.lineTo(3.34, 0.66);
  locoCabShape.lineTo(3.38, 1.15);
  locoCabShape.lineTo(3.04, 1.38);
  locoCabShape.lineTo(2.86, 1.92);
  locoCabShape.lineTo(2.15, 1.92);
  locoCabShape.closePath();

  const locoCabGeo = trackGeo(
    geometries,
    new THREE.ExtrudeGeometry(locoCabShape, {
      depth: 1.12,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 2,
    }),
  );
  locoCabGeo.translate(0, 0, -0.56);
  const locoCab = new THREE.Mesh(locoCabGeo, mats.cabPaint);
  locoCab.castShadow = true;
  locoCab.receiveShadow = true;
  train.add(locoCab);

  // Long Engine Hood + Dynamic Brake Radiators
  const hoodGeo = trackGeo(geometries, new RoundedBoxGeometry(1.9, 1.18, 0.96, 2, 0.04));
  const hood = new THREE.Mesh(hoodGeo, mats.cabSecondary);
  hood.position.set(1.25, 1.26, 0);
  hood.castShadow = true;
  hood.receiveShadow = true;
  train.add(hood);

  // Radiator Wings at top rear
  const radWingGeo = trackGeo(geometries, new RoundedBoxGeometry(0.95, 0.16, 1.18, 2, 0.03));
  const radWing = new THREE.Mesh(radWingGeo, mats.cabPaint);
  radWing.position.set(0.84, 1.78, 0);
  radWing.castShadow = true;
  train.add(radWing);

  // Tinted Locomotive Windshields + Side Windows
  const locoWindGeo = trackGeo(geometries, new THREE.BoxGeometry(0.08, 0.36, 0.94));
  const locoWind = new THREE.Mesh(locoWindGeo, mats.tintedGlass);
  locoWind.position.set(2.97, 1.63, 0);
  locoWind.rotation.z = 0.32;
  train.add(locoWind);

  const locoSideWin = new THREE.Mesh(
    trackGeo(geometries, new THREE.BoxGeometry(0.46, 0.32, 1.24)),
    mats.tintedGlass,
  );
  locoSideWin.position.set(2.55, 1.62, 0);
  train.add(locoSideWin);

  // Front Snowplow Pilot + Glowing Twin Headlight & Ditch Lights
  const plowGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.32, 0.45, 0.3, 4));
  plowGeo.rotateY(Math.PI / 4);
  const plow = new THREE.Mesh(plowGeo, mats.darkSteel);
  plow.position.set(3.38, 0.36, 0);
  plow.scale.set(0.75, 1, 1.45);
  train.add(plow);

  const mainBeam = new THREE.Mesh(
    trackGeo(geometries, new THREE.BoxGeometry(0.08, 0.14, 0.24)),
    mats.headlightGlow,
  );
  mainBeam.position.set(3.41, 1.14, 0);
  train.add(mainBeam);

  for (const side of [-1, 1]) {
    const ditch = new THREE.Mesh(
      trackGeo(geometries, new THREE.CylinderGeometry(0.055, 0.055, 0.08, 12)),
      mats.headlightGlow,
    );
    ditch.rotation.z = Math.PI / 2;
    ditch.position.set(3.42, 0.7, side * 0.36);
    train.add(ditch);

    // Chrome catwalk handrails along engine hood
    const railBar = new THREE.Mesh(
      trackGeo(geometries, new THREE.BoxGeometry(1.92, 0.03, 0.03)),
      mats.brushedChrome,
    );
    railBar.position.set(1.26, 0.96, side * 0.59);
    train.add(railBar);
  }

  // Spinning Dynamic Brake Cooling Fan on Rooftop
  const fanGroup = new THREE.Group();
  fanGroup.position.set(0.84, 1.88, 0);
  const fanBladeGeo = trackGeo(geometries, new THREE.BoxGeometry(0.36, 0.02, 0.08));
  for (let i = 0; i < 3; i += 1) {
    const fb = new THREE.Mesh(fanBladeGeo, mats.alloyRim);
    fb.rotation.y = (i * Math.PI) / 3;
    fanGroup.add(fb);
  }
  train.add(fanGroup);

  // Intermodal Double-Stack Well Car (X: -3.55 to +0.05)
  const wellBaseGeo = trackGeo(geometries, new RoundedBoxGeometry(3.35, 0.18, 1.16, 2, 0.02));
  const wellBase = new THREE.Mesh(wellBaseGeo, mats.cabSecondary);
  wellBase.position.set(-1.72, 0.42, 0);
  wellBase.castShadow = true;
  train.add(wellBase);

  const wellSideGeo = trackGeo(geometries, new THREE.BoxGeometry(2.65, 0.34, 0.07));
  for (const side of [-1, 1]) {
    const ws = new THREE.Mesh(wellSideGeo, mats.cabPaint);
    ws.position.set(-1.72, 0.58, side * 0.56);
    ws.castShadow = true;
    train.add(ws);
  }

  // Double-Stacked Corrugated ISO Containers
  const stackGeo = trackGeo(geometries, new RoundedBoxGeometry(2.48, 0.64, 1.0, 2, 0.025));
  const bottomContainer = new THREE.Mesh(stackGeo, mats.containerIvory);
  bottomContainer.position.set(-1.72, 0.82, 0);
  bottomContainer.castShadow = true;
  bottomContainer.receiveShadow = true;
  train.add(bottomContainer);

  const topContainer = new THREE.Mesh(stackGeo, mats.containerTeal);
  topContainer.position.set(-1.72, 1.48, 0);
  topContainer.castShadow = true;
  topContainer.receiveShadow = true;
  train.add(topContainer);

  // Steel Rail Bogie Wheelsets (8 axles = 16 wheels sitting flush on rail top at y = 0.14)
  const railWheels: THREE.Mesh[] = [];
  const wheelGeo = trackGeo(geometries, new THREE.CylinderGeometry(0.19, 0.19, 0.08, 22));
  wheelGeo.rotateX(Math.PI / 2);

  const axleXs = [-3.12, -2.7, -0.74, -0.32, 0.62, 1.06, 2.52, 2.96];
  for (const ax of axleXs) {
    for (const side of [-1, 1]) {
      const rw = new THREE.Mesh(wheelGeo, mats.alloyRim);
      rw.position.set(ax, 0.33, side * 0.44);
      rw.castShadow = true;
      train.add(rw);
      railWheels.push(rw);
    }
  }

  return {
    group: root,
    targetY: 0.95,
    cameraDistance: 6.5,
    animate: (elapsed, delta) => {
      fanGroup.rotation.y += delta * 12;
      for (const rw of railWheels) {
        rw.rotation.z -= delta * 4.5;
      }
      train.position.y = Math.sin(elapsed * 7.5) * 0.005;
    },
    dispose: () => {
      geometries.forEach((g) => g.dispose());
    },
  };
}

export function buildCarrierModel(
  mode: TransportMode,
  mats: CarrierMaterialPalette,
): BuiltCarrierModel {
  if (mode === "ROAD") return buildRoadTruck(mats);
  if (mode === "AIR") return buildAirFreighter(mats);
  if (mode === "RAIL") return buildRailFreight(mats);
  return buildSeaVessel(mats);
}
