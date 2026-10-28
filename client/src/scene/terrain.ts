// Ground, grass and wildflowers.
//
// The ground is one big displaced plane that runs well past the walkable
// edge, so the edge of the world never shows. Grass tufts and flowers are a
// patch of instances that follows the camera: each instance works out its
// own world cell from gl_InstanceID, so blades are stable in the world (no
// swimming) and cost nothing on the CPU. Height comes from a texture baked
// from the same terrainHeight() the server uses.

import * as THREE from "three";
import { hash2 } from "../../../shared/rng";
import { GROUND_MARGIN, MAX_HALF, WORLD, terrainHeight } from "../../../shared/world";

export const GROUND_HALF = MAX_HALF + GROUND_MARGIN;
const HM_RES = 640;
const HM_MIN = -GROUND_HALF;
const HM_SIZE = GROUND_HALF * 2;
const H_LO = -3;
const H_HI = 4;

function valueNoise(x: number, z: number, seed: number) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function heightTexture(): THREE.DataTexture {
  const data = new Uint8Array(HM_RES * HM_RES * 4);
  for (let j = 0; j < HM_RES; j++) {
    for (let i = 0; i < HM_RES; i++) {
      const x = HM_MIN + ((i + 0.5) / HM_RES) * HM_SIZE;
      const z = HM_MIN + ((j + 0.5) / HM_RES) * HM_SIZE;
      const h = terrainHeight(x, z);
      const o = (j * HM_RES + i) * 4;
      data[o] = Math.round(((h - H_LO) / (H_HI - H_LO)) * 255);
      let wet = 0;
      for (const p of WORLD.ponds) if (Math.hypot(x - p.x, z - p.z) < p.r + 2.2) wet = 255;
      data[o + 1] = wet;
      data[o + 2] = Math.round(valueNoise(x / 38, z / 38, 5) * 255);
      data[o + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(data, HM_RES, HM_RES, THREE.RGBAFormat);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const GROUND_COLORS = {
  base: new THREE.Color("#9bc96f"),
  warm: new THREE.Color("#b7d377"),
  deep: new THREE.Color("#7fb562"),
  bank: new THREE.Color("#b9c983"),
};

export function makeGround(): THREE.Mesh {
  const segs = 300;
  const g = new THREE.PlaneGeometry(HM_SIZE, HM_SIZE, segs, segs);
  g.rotateX(-Math.PI / 2);
  const pos = g.getAttribute("position");
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    pos.setY(i, terrainHeight(x, z));
    // Meadow patches: warm, sunny clearings and deeper greens.
    const n1 = valueNoise(x / 38, z / 38, 5);
    const n2 = valueNoise(x / 11, z / 11, 9);
    c.copy(GROUND_COLORS.base).lerp(GROUND_COLORS.warm, Math.max(0, n1 - 0.45) * 1.6);
    c.lerp(GROUND_COLORS.deep, Math.max(0, 0.42 - n1) * 1.4 + (n2 - 0.5) * 0.12);
    for (const p of WORLD.ponds) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < p.r + 4) c.lerp(GROUND_COLORS.bank, Math.min(1, (p.r + 4 - d) / 3) * 0.7);
    }
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  const mesh = new THREE.Mesh(g, m);
  mesh.name = "ground";
  return mesh;
}

const PATCH_GLSL = /* glsl */ `
uniform vec2 uCenter;
uniform float uCell;
uniform float uN;
uniform float uTime;
uniform float uFadeNear;
uniform float uFadeFar;
uniform vec3 uCam;
uniform sampler2D uHeight;
attribute float aTip;
varying float vTip;
varying float vHash;
float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float groundAt(vec2 w) {
  vec2 uv = (w - vec2(${HM_MIN.toFixed(1)})) / ${HM_SIZE.toFixed(1)};
  return mix(${H_LO.toFixed(1)}, ${H_HI.toFixed(1)}, texture2D(uHeight, uv).r);
}
vec4 cellInfo(out vec2 wp, out float wet, out float meadow) {
  float id = float(gl_InstanceID);
  vec2 cell = floor(uCenter / uCell) + vec2(mod(id, uN), floor(id / uN)) - floor(uN * 0.5);
  float a = h21(cell);
  float b = h21(cell + 17.31);
  wp = (cell + vec2(a, b)) * uCell;
  vec2 uv = (wp - vec2(${HM_MIN.toFixed(1)})) / ${HM_SIZE.toFixed(1)};
  vec4 t = texture2D(uHeight, uv);
  wet = t.g;
  meadow = t.b;
  return vec4(a, b, h21(cell + 3.7), h21(cell + 9.1));
}
`;

function tuftGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const tip: number[] = [];
  const blades = 7;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7;
    const r = 0.04 + (b % 3) * 0.06;
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    const w = 0.06;
    const h = 0.24 + ((b * 7) % 5) * 0.035;
    const lean = 0.1;
    const px = Math.cos(a + 1.57) * w;
    const pz = Math.sin(a + 1.57) * w;
    pos.push(bx - px, 0, bz - pz, bx + px, 0, bz + pz, bx + Math.cos(a) * lean, h, bz + Math.sin(a) * lean);
    tip.push(0, 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute("aTip", new THREE.Float32BufferAttribute(tip, 1));
  return g;
}

function flowerGeometry(): THREE.BufferGeometry {
  // Five petals and a centre on a short stem. aTip: 0 stem, 0.5 petal, 1 centre.
  const pos: number[] = [];
  const tip: number[] = [];
  const top = 0.32;
  const tri = (a: number[], b: number[], c: number[], k: number) => {
    pos.push(...a, ...b, ...c);
    tip.push(k, k, k);
  };
  tri([-0.02, 0, 0], [0.02, 0, 0], [0, top, 0], 0);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const a0 = a - 0.42;
    const a1 = a + 0.42;
    const r = 0.13;
    tri([0, top, 0], [Math.cos(a0) * r, top + 0.012, Math.sin(a0) * r], [Math.cos(a) * r * 1.25, top + 0.02, Math.sin(a) * r * 1.25], 0.5);
    tri([0, top, 0], [Math.cos(a) * r * 1.25, top + 0.02, Math.sin(a) * r * 1.25], [Math.cos(a1) * r, top + 0.012, Math.sin(a1) * r], 0.5);
  }
  for (let i = 0; i < 6; i++) {
    const a0 = (i / 6) * Math.PI * 2;
    const a1 = ((i + 1) / 6) * Math.PI * 2;
    tri([0, top + 0.045, 0], [Math.cos(a0) * 0.045, top + 0.03, Math.sin(a0) * 0.045], [Math.cos(a1) * 0.045, top + 0.03, Math.sin(a1) * 0.045], 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute("aTip", new THREE.Float32BufferAttribute(tip, 1));
  return g;
}

export interface Patch {
  mesh: THREE.Mesh;
  uniforms: Record<string, THREE.IUniform>;
}

function patch(kind: "grass" | "flower", heightTex: THREE.Texture, n: number, cell: number, fadeNear: number, fadeFar: number): Patch {
  const geo = new THREE.InstancedBufferGeometry();
  const src = kind === "grass" ? tuftGeometry() : flowerGeometry();
  for (const [k, a] of Object.entries(src.attributes)) geo.setAttribute(k, a);
  geo.instanceCount = n * n;
  const uniforms: Record<string, THREE.IUniform> = {
    uCenter: { value: new THREE.Vector2() },
    uCell: { value: cell },
    uN: { value: n },
    uTime: { value: 0 },
    uFadeNear: { value: fadeNear },
    uFadeFar: { value: fadeFar },
    uCam: { value: new THREE.Vector3() },
    uHeight: { value: heightTex },
  };
  const m = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    const place =
      kind === "grass"
        ? /* glsl */ `
          vec2 wp; float wet; float meadow;
          vec4 hs = cellInfo(wp, wet, meadow);
          float s = (0.7 + hs.z * 0.75) * (1.0 - step(0.5, wet));
          float ang = hs.w * 6.2831;
          vec3 p = position;
          p.xz = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * p.xz;
          // Wind: a slow travelling gust plus a quick flutter, tips only.
          float gust = sin(wp.x * 0.08 + wp.y * 0.05 + uTime * 1.3) * 0.5 + 0.5;
          float bend = aTip * (0.05 + 0.12 * gust);
          p.x += bend * (0.8 + 0.2 * sin(uTime * 4.0 + hs.x * 20.0));
          p.z += bend * 0.35 * sin(uTime * 3.1 + hs.y * 20.0);
          float gy = groundAt(wp);
          float d = distance(vec3(wp.x, gy, wp.y), uCam);
          s *= 1.0 - smoothstep(uFadeNear, uFadeFar, d);
          p *= s;
          vec3 transformed = vec3(wp.x, gy - 0.02, wp.y) + p;
          vTip = aTip; vHash = meadow;`
        : /* glsl */ `
          vec2 wp; float wet; float meadow;
          vec4 hs = cellInfo(wp, wet, meadow);
          // Flowers gather in the sunny meadow patches.
          float chance = mix(0.04, 0.38, smoothstep(0.35, 0.75, meadow));
          float s = step(hs.z, chance) * (1.0 - step(0.5, wet)) * (0.8 + hs.w * 0.5);
          vec3 p = position;
          p.x += aTip * sin(uTime * 1.6 + wp.x * 0.1) * 0.03;
          float gy = groundAt(wp);
          float d = distance(vec3(wp.x, gy, wp.y), uCam);
          s *= 1.0 - smoothstep(uFadeNear, uFadeFar, d);
          p *= s;
          vec3 transformed = vec3(wp.x, gy - 0.02, wp.y) + p;
          vTip = aTip; vHash = hs.w;`;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${PATCH_GLSL}`)
      .replace("#include <begin_vertex>", place);
    const color =
      kind === "grass"
        ? /* glsl */ `
          vec3 base = mix(vec3(0.20, 0.42, 0.10), vec3(0.25, 0.47, 0.12), vHash);
          vec3 tipc = mix(vec3(0.36, 0.60, 0.16), vec3(0.45, 0.64, 0.18), vHash);
          diffuseColor.rgb = mix(base, tipc, vTip);`
        : /* glsl */ `
          vec3 petals[4] = vec3[4](vec3(0.95, 0.94, 0.88), vec3(1.0, 0.66, 0.1), vec3(0.95, 0.42, 0.58), vec3(0.56, 0.45, 0.95));
          vec3 pc = petals[int(vHash * 3.99)];
          diffuseColor.rgb = vTip < 0.25 ? vec3(0.15, 0.36, 0.08) : (vTip > 0.75 ? vec3(1.0, 0.6, 0.06) : pc);`;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vTip;\nvarying float vHash;")
      .replace("#include <color_fragment>", `#include <color_fragment>\n${color}`)
      // Light blades and petals like the ground under them, whichever side faces the camera.
      .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);");
  };
  m.customProgramCacheKey = () => `patch-${kind}`;
  const mesh = new THREE.Mesh(geo, m);
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}

export class Meadow {
  readonly ground = makeGround();
  readonly heightTex = heightTexture();
  readonly grass: Patch;
  readonly flowers: Patch;

  constructor(scene: THREE.Scene, mobile: boolean) {
    this.grass = patch("grass", this.heightTex, mobile ? 150 : 210, 1.0, 50, 92);
    this.flowers = patch("flower", this.heightTex, mobile ? 64 : 84, 3.1, 80, 128);
    scene.add(this.ground, this.grass.mesh, this.flowers.mesh);
  }

  update(target: THREE.Vector3, cam: THREE.Vector3, time: number) {
    for (const p of [this.grass, this.flowers]) {
      // Centre the patch between the camera and what it looks at, where blades are visible.
      p.uniforms.uCenter.value.set(target.x * 0.6 + cam.x * 0.4, target.z * 0.6 + cam.z * 0.4);
      p.uniforms.uCam.value.copy(cam);
      p.uniforms.uTime.value = time;
    }
  }
}
