"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RectAreaLightUniformsLib } from "three/examples/jsm/lights/RectAreaLightUniformsLib.js";
import { CarrierWireframe } from "@/components/control-tower/carrier-wireframe";
import { createCarrierMaterials, type CarrierMaterialPalette } from "./materials";
import { buildCarrierModel, type BuiltCarrierModel, type TransportMode } from "./models";

const DEFAULT_CAMERA_POS = new THREE.Vector3(4.45, 2.35, 4.75);
const DEFAULT_TARGET = new THREE.Vector3(0, 0.92, 0);

function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) return true;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? "");
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return true;
  }
}

function resolveStageBackgroundHex(): number {
  if (typeof window === "undefined") return 0x131b1a;
  const root = document.documentElement;
  const meta = document
    .querySelector('meta[name="color-scheme"]')
    ?.getAttribute("content");
  const explicitTheme = root.getAttribute("data-theme");
  const isDark =
    explicitTheme === "dark" ||
    meta === "dark" ||
    (explicitTheme !== "light" &&
      meta !== "light" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  return isDark ? 0x131b1a : 0xf1f4f6;
}

export function Carrier3DStage({ mode }: { mode: TransportMode }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef<TransportMode>(mode);
  const resetCamFnRef = useRef<(() => void) | null>(null);
  const switchModelFnRef = useRef<((nextMode: TransportMode) => void) | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);

  modeRef.current = mode;

  useEffect(() => {
    switchModelFnRef.current?.(mode);
  }, [mode]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const isSoftwareGl = detectSoftwareWebGL();

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !isSoftwareGl,
        powerPreference: "high-performance",
        alpha: false,
      });
    } catch {
      setWebglFailed(true);
      return;
    }

    const width = Math.max(container.clientWidth, 300);
    const height = Math.max(container.clientHeight, 180);

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    renderer.shadowMap.enabled = !isSoftwareGl;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.display = "block";
    renderer.domElement.style.outline = "none";

    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const initialBg = resolveStageBackgroundHex();
    scene.background = new THREE.Color(initialBg);
    scene.fog = new THREE.FogExp2(initialBg, 0.042);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envTarget.texture;
    pmrem.dispose();

    const camera = new THREE.PerspectiveCamera(34, width / height, 0.1, 60);
    camera.position.copy(DEFAULT_CAMERA_POS);
    camera.lookAt(DEFAULT_TARGET);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(DEFAULT_TARGET);
    controls.enableDamping = !isSoftwareGl;
    controls.dampingFactor = 0.07;
    controls.enablePan = false;
    controls.minDistance = 4.2;
    controls.maxDistance = 10.5;
    controls.minPolarAngle = 0.28;
    controls.maxPolarAngle = Math.PI / 2 - 0.05;
    controls.autoRotate = !isSoftwareGl && !reducedMotion;
    controls.autoRotateSpeed = 0.65;
    controls.update();

    // 3-Point Warm/Cool Studio Lighting Rig (<= 1 shadow caster)
    const hemi = new THREE.HemisphereLight(0xdceeff, 0x1a2626, 0.85);
    scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xfff1dc, 2.25);
    keyLight.position.set(5.5, 8.2, 5.2);
    keyLight.castShadow = !isSoftwareGl;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 22;
    keyLight.shadow.camera.left = -5.5;
    keyLight.shadow.camera.right = 5.5;
    keyLight.shadow.camera.top = 5.5;
    keyLight.shadow.camera.bottom = -5.5;
    keyLight.shadow.bias = -0.0005;
    keyLight.shadow.normalBias = 0.02;
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x7be6da, 1.15);
    rimLight.position.set(-5.8, 4.2, -5.2);
    scene.add(rimLight);

    if (!isSoftwareGl) {
      RectAreaLightUniformsLib.init();
      const softbox = new THREE.RectAreaLight(0xeef6ff, 2.6, 7.5, 2.5);
      softbox.position.set(0, 5.6, 3.2);
      softbox.lookAt(0, 0.6, 0);
      scene.add(softbox);
    }

    const maxAnisotropy = Math.min(renderer.capabilities.getMaxAnisotropy() || 1, 8);
    const palette: CarrierMaterialPalette = createCarrierMaterials(maxAnisotropy, isSoftwareGl);

    let activeModel: BuiltCarrierModel | null = null;
    let enterProgress = 1;
    let cameraResetActive = false;
    let userInteracting = false;
    let contextLost = false;
    let frameId = 0;
    let disposed = false;

    const syncThemeColors = () => {
      const hex = resolveStageBackgroundHex();
      (scene.background as THREE.Color).setHex(hex);
      if (scene.fog instanceof THREE.FogExp2) {
        scene.fog.color.setHex(hex);
      }
    };

    const observer = new MutationObserver(syncThemeColors);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class", "style"],
    });
    const colorMedia = window.matchMedia?.("(prefers-color-scheme: dark)");
    colorMedia?.addEventListener("change", syncThemeColors);

    const mountModel = (nextMode: TransportMode) => {
      if (activeModel) {
        scene.remove(activeModel.group);
        activeModel.dispose();
        activeModel = null;
      }
      const built = buildCarrierModel(nextMode, palette);
      built.group.scale.setScalar(0.92);
      scene.add(built.group);
      activeModel = built;
      enterProgress = 0;
      controls.target.y = built.targetY;
    };

    mountModel(modeRef.current);
    switchModelFnRef.current = mountModel;

    resetCamFnRef.current = () => {
      cameraResetActive = true;
      controls.autoRotate = !isSoftwareGl && !reducedMotion;
    };

    const onControlsStart = () => {
      userInteracting = true;
      cameraResetActive = false;
      controls.autoRotate = false;
    };
    const onControlsEnd = () => {
      userInteracting = false;
    };
    controls.addEventListener("start", onControlsStart);
    controls.addEventListener("end", onControlsEnd);

    const onContextLost = (e: Event) => {
      e.preventDefault();
      contextLost = true;
      setWebglFailed(true);
    };
    const onContextRestored = () => {
      contextLost = false;
      setWebglFailed(false);
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);
    renderer.domElement.addEventListener("webglcontextrestored", onContextRestored);

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry || disposed) return;
      const w = Math.max(Math.round(entry.contentRect.width), 280);
      const h = Math.max(Math.round(entry.contentRect.height), 180);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    });
    resizeObserver.observe(container);

    if (!isSoftwareGl) {
      renderer.compile(scene, camera);
    }

    const clock = new THREE.Clock();

    function afterDraw(cb: () => void) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      const sync = gl.fenceSync ? gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) : null;
      gl.flush();
      if (!sync) {
        frameId = window.setTimeout(cb, 80);
        return;
      }
      const poll = () => {
        if (disposed) {
          gl.deleteSync(sync);
          return;
        }
        const state = gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          frameId = window.setTimeout(poll, 5);
        } else {
          gl.deleteSync(sync);
          frameId = window.setTimeout(cb, 80);
        }
      };
      frameId = window.setTimeout(poll, 5);
    }

    function tick() {
      if (disposed || contextLost) return;

      const delta = Math.min(clock.getDelta(), 0.08);
      const elapsed = clock.getElapsedTime();

      if (activeModel) {
        if (!reducedMotion) {
          activeModel.animate(elapsed, delta);
        }
        if (enterProgress < 1) {
          enterProgress = Math.min(1, enterProgress + delta * 5);
          const s = THREE.MathUtils.damp(activeModel.group.scale.x, 1, 10, delta);
          activeModel.group.scale.setScalar(enterProgress >= 0.99 ? 1 : s);
        }
      }

      if (cameraResetActive && !userInteracting) {
        camera.position.x = THREE.MathUtils.damp(camera.position.x, DEFAULT_CAMERA_POS.x, 7, delta);
        camera.position.y = THREE.MathUtils.damp(camera.position.y, DEFAULT_CAMERA_POS.y, 7, delta);
        camera.position.z = THREE.MathUtils.damp(camera.position.z, DEFAULT_CAMERA_POS.z, 7, delta);
        const targetY = activeModel?.targetY ?? DEFAULT_TARGET.y;
        controls.target.x = THREE.MathUtils.damp(controls.target.x, 0, 7, delta);
        controls.target.y = THREE.MathUtils.damp(controls.target.y, targetY, 7, delta);
        controls.target.z = THREE.MathUtils.damp(controls.target.z, 0, 7, delta);
        if (camera.position.distanceTo(DEFAULT_CAMERA_POS) < 0.03) {
          camera.position.copy(DEFAULT_CAMERA_POS);
          cameraResetActive = false;
        }
      }

      controls.update();
      renderer.render(scene, camera);

      if (isSoftwareGl) {
        afterDraw(tick);
      } else {
        frameId = window.requestAnimationFrame(tick);
      }
    }

    if (isSoftwareGl) {
      tick();
    } else {
      frameId = window.requestAnimationFrame(tick);
    }

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      window.clearTimeout(frameId);
      resizeObserver.disconnect();
      observer.disconnect();
      colorMedia?.removeEventListener("change", syncThemeColors);
      controls.removeEventListener("start", onControlsStart);
      controls.removeEventListener("end", onControlsEnd);
      controls.dispose();
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("webglcontextrestored", onContextRestored);

      if (activeModel) {
        scene.remove(activeModel.group);
        activeModel.dispose();
        activeModel = null;
      }
      palette.dispose();
      envTarget.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
      resetCamFnRef.current = null;
      switchModelFnRef.current = null;
    };
  }, []);

  if (webglFailed) {
    return <CarrierWireframe mode={mode} />;
  }

  return (
    <div
      className="ct-3d-shell"
      aria-label={`Interactive 3D ${mode.toLowerCase()} carrier model`}
    >
      <div
        ref={mountRef}
        className="ct-3d-canvas"
        onDoubleClick={() => resetCamFnRef.current?.()}
      />
      <div className="ct-3d-hud">
        <span className="ct-3d-hint">3D · Drag to orbit</span>
        <button
          type="button"
          className="ct-3d-reset"
          onClick={() => resetCamFnRef.current?.()}
          title="Reset 3D camera angle"
          aria-label="Reset 3D camera angle"
        >
          <RotateCcw size={12} strokeWidth={2} aria-hidden="true" />
          <span>Reset</span>
        </button>
      </div>
    </div>
  );
}
