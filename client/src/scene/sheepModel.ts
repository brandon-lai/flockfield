// Sheep geometry and materials.
//
// Every body part is one instanced draw for the whole flock (PRD "Rendering
// performance"). Parts carry no skeleton: each vertex knows which part it
// belongs to, and the vertex shader poses it from a handful of per-sheep
// numbers (heading, hop, squash, lie-down, head pitch/yaw, walk phase...).
// The CPU decides the pose; the GPU bends the legs, flops the ears, wiggles
// the tail and breathes.
//
// Local space: +Z is forward, +Y up, ground at y = 0. An adult is about 1.6
// long. Head parts are modelled around the neck pivot so one rotation moves
// the head, face, ears and any hat together.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { BOW } from "../../../shared/traits";

export const NECK = new THREE.Vector3(0, 1.1, 0.56);
const HEAD_C = new THREE.Vector3(0, 0.06, 0.24);
const HEAD_R = new THREE.Vector3(0.31, 0.34, 0.41);

type Rgb = [number, number, number];
interface PartOpts {
  /** r: 1 = wool colour, 0 = face colour; g: shade multiplier. Or a fixed RGB with PART_FIXED. */
  color?: Rgb | ((p: THREE.Vector3, n: THREE.Vector3) => Rgb);
  attrs?: Record<string, number[]>;
}

function prep(g: THREE.BufferGeometry, o: PartOpts = {}): THREE.BufferGeometry {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute("uv");
  const pos = geo.getAttribute("position");
  const nor = geo.getAttribute("normal");
  const col = new Float32Array(pos.count * 3);
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    n.fromBufferAttribute(nor, i);
    const c = typeof o.color === "function" ? o.color(p, n) : (o.color ?? [1, 1, 0]);
    col.set(c, i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  for (const [name, v] of Object.entries(o.attrs ?? {})) {
    const a = new Float32Array(pos.count * v.length);
    for (let i = 0; i < pos.count; i++) a.set(v, i * v.length);
    geo.setAttribute(name, new THREE.BufferAttribute(a, v.length));
  }
  return geo;
}

const sphere = (r: number, w = 12, h = 9) => new THREE.SphereGeometry(r, w, h);
const ico = (r: number, d = 1) => new THREE.IcosahedronGeometry(r, d);

/** A point on the head ellipsoid along a direction, plus its normal. */
function headSurface(dir: THREE.Vector3): { p: THREE.Vector3; n: THREE.Vector3 } {
  const d = dir.clone().normalize();
  const p = HEAD_C.clone().add(d.clone().multiply(HEAD_R));
  const n = new THREE.Vector3(d.x / HEAD_R.x, d.y / HEAD_R.y, d.z / HEAD_R.z).normalize();
  return { p, n };
}

/** A sphere squashed to `scale`, sat on the surface facing outward. */
function onSurface(dir: THREE.Vector3, r: number, scale: THREE.Vector3, lift = 0, seg = 10) {
  const { p, n } = headSurface(dir);
  const g = sphere(r, seg, Math.max(6, seg - 3));
  g.scale(scale.x, scale.y, scale.z);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  g.applyQuaternion(q);
  g.translate(p.x + n.x * lift, p.y + n.y * lift, p.z + n.z * lift);
  return { g, p };
}

// Wool shading: a little darker underneath (felt in shadow), a little random per puff.
const woolShade = (jitter: number) => (_p: THREE.Vector3, n: THREE.Vector3): Rgb => [1, 0.8 + 0.2 * (n.y * 0.5 + 0.5) + jitter, 0];

export function bodyGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const core = ico(1, 2);
  core.scale(0.56, 0.48, 0.72);
  core.translate(0, 0.98, -0.04);
  parts.push(prep(core, { color: woolShade(-0.02) }));
  // Puffs on the surface of the body ellipsoid: a fibonacci spiral, skipping
  // the underside nobody sees.
  const n = 26;
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 1.55;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const th = i * 2.39996;
    const d = new THREE.Vector3(Math.cos(th) * rad, y, Math.sin(th) * rad);
    const g = ico(0.25 + ((i * 37) % 7) * 0.016, 1);
    g.translate(d.x * 0.5, 0.98 + d.y * 0.42, -0.04 + d.z * 0.66);
    parts.push(prep(g, { color: woolShade(((i * 53) % 9) * 0.008 - 0.03) }));
  }
  return mergeGeometries(parts)!;
}

export function farBodyGeometry(): THREE.BufferGeometry {
  const g = ico(1, 1);
  g.scale(0.66, 0.56, 0.84);
  g.translate(0, 0.96, -0.04);
  return prep(g, { color: woolShade(0) });
}

export function headGeometry(): THREE.BufferGeometry {
  const face = sphere(1, 16, 12);
  face.scale(HEAD_R.x, HEAD_R.y, HEAD_R.z);
  face.translate(HEAD_C.x, HEAD_C.y, HEAD_C.z);
  const parts = [prep(face, { color: (_p, n) => [0, 0.86 + 0.14 * (n.y * 0.5 + 0.5), 0] })];
  // A tuft of wool on top of the head.
  const tuft: [number, number, number, number][] = [
    [0, 0.37, 0.08, 0.17],
    [-0.13, 0.32, 0.02, 0.14],
    [0.13, 0.32, 0.02, 0.14],
    [0, 0.3, -0.1, 0.15],
  ];
  for (const [x, y, z, r] of tuft) {
    const g = ico(r, 1);
    g.translate(x, y, z);
    parts.push(prep(g, { color: woolShade(0.02) }));
  }
  return mergeGeometries(parts)!;
}

export function farHeadGeometry(): THREE.BufferGeometry {
  const g = sphere(1, 8, 6);
  g.scale(HEAD_R.x * 1.05, HEAD_R.y * 1.05, HEAD_R.z);
  g.translate(HEAD_C.x, HEAD_C.y, HEAD_C.z);
  return prep(g, { color: [0, 0.92, 0] });
}

/** Eyes (with highlights), rosy cheeks and nostrils. Fixed colours. */
export function faceGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    // aEye: xyz = centre to blink around, w = 1 if this vertex blinks.
    const eye = onSurface(new THREE.Vector3(side * 0.5, 0.28, 0.82), 0.068, new THREE.Vector3(1, 1.12, 0.62), -0.012);
    parts.push(prep(eye.g, { color: [0.11, 0.09, 0.1], attrs: { aEye: [eye.p.x, eye.p.y, eye.p.z, 1] } }));
    const hl = onSurface(new THREE.Vector3(side * 0.43, 0.38, 0.82), 0.022, new THREE.Vector3(1, 1, 0.5), 0.012, 6);
    parts.push(prep(hl.g, { color: [1, 1, 1], attrs: { aEye: [eye.p.x, eye.p.y, eye.p.z, 1] } }));
    const cheek = onSurface(new THREE.Vector3(side * 0.66, -0.06, 0.72), 0.075, new THREE.Vector3(1, 0.62, 0.25), -0.006);
    parts.push(prep(cheek.g, { color: [0.98, 0.62, 0.66], attrs: { aEye: [0, 0, 0, 0] } }));
    const nose = onSurface(new THREE.Vector3(side * 0.16, -0.18, 1), 0.024, new THREE.Vector3(1, 0.7, 0.5), -0.004, 6);
    parts.push(prep(nose.g, { color: [0.24, 0.16, 0.16], attrs: { aEye: [0, 0, 0, 0] } }));
  }
  return mergeGeometries(parts)!;
}

export function earsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const g = sphere(1, 10, 7);
    g.scale(0.19, 0.055, 0.1);
    // Root at the origin, ear extending outward along x.
    g.translate(side * 0.16, 0, 0);
    const root = [side * 0.26, 0.2, 0.12];
    parts.push(prep(g, { color: (p) => [0, Math.abs(p.x) > 0.2 ? 0.92 : 0.82, 0], attrs: { aEar: [side, ...root] } }));
  }
  return mergeGeometries(parts)!;
}

export function legsGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, z] of [
    [-0.27, 0.42],
    [0.27, 0.42],
    [-0.27, -0.42],
    [0.27, -0.42],
  ]) {
    const g = new THREE.CylinderGeometry(0.085, 0.075, 0.62, 8, 3);
    g.translate(0, 0.31, 0);
    // Trot gait: diagonal pairs move together.
    const phase = (x < 0) === (z > 0) ? 0 : Math.PI;
    g.translate(x, 0, z);
    parts.push(prep(g, { color: (p) => [0, p.y < 0.1 ? 0.55 : 0.88, 0], attrs: { aLeg: [x, z, phase] } }));
  }
  return mergeGeometries(parts)!;
}

export function tailGeometry(): THREE.BufferGeometry {
  const g = ico(0.15, 1);
  g.translate(0, 1.04, -0.78);
  return prep(g, { color: woolShade(0.03) });
}

export function bowGeometry(): THREE.BufferGeometry {
  // Sits on the head tuft, a little to one side.
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    const g = new THREE.ConeGeometry(0.1, 0.17, 8);
    g.rotateZ((side * Math.PI) / 2);
    g.translate(side * 0.09, 0, 0);
    parts.push(prep(g, { color: [1, 0.95, 0] }));
  }
  const knot = sphere(0.055, 8, 6);
  parts.push(prep(knot, { color: [1, 0.8, 0] }));
  const g = mergeGeometries(parts)!;
  g.rotateZ(-0.35);
  g.translate(0.17, 0.43, 0.02);
  return g;
}

export function bellGeometry(): THREE.BufferGeometry {
  const collar = new THREE.TorusGeometry(0.27, 0.035, 6, 20);
  collar.rotateX(Math.PI / 2 - 0.5);
  collar.translate(0, 1.02, 0.5);
  const bell = sphere(0.085, 10, 8);
  bell.translate(0, 0.86, 0.72);
  const clap = sphere(0.03, 6, 4);
  clap.translate(0, 0.79, 0.74);
  return mergeGeometries([
    prep(collar, { color: [0.86, 0.33, 0.33] }),
    prep(bell, { color: [0.98, 0.79, 0.33] }),
    prep(clap, { color: [0.6, 0.45, 0.2] }),
  ])!;
}

export function crownGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const colors: Rgb[] = [
    [1, 1, 1],
    [1, 0.72, 0.8],
    [1, 0.86, 0.4],
    [0.78, 0.7, 1],
  ];
  const n = 9;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const x = Math.cos(a) * 0.25;
    const z = 0.02 + Math.sin(a) * 0.27;
    const f = sphere(0.062, 8, 6);
    f.scale(1, 0.6, 1);
    f.translate(x, 0.38 + Math.sin(a * 2) * 0.02, z);
    parts.push(prep(f, { color: colors[i % colors.length] }));
    const c = sphere(0.025, 6, 4);
    c.translate(x, 0.415, z);
    parts.push(prep(c, { color: [1, 0.78, 0.25] }));
    const leaf = sphere(0.05, 6, 4);
    leaf.scale(1.4, 0.4, 0.7);
    const la = a + Math.PI / n;
    leaf.translate(Math.cos(la) * 0.26, 0.36, 0.02 + Math.sin(la) * 0.28);
    parts.push(prep(leaf, { color: [0.45, 0.72, 0.36] }));
  }
  return mergeGeometries(parts)!;
}

export function shadowGeometry(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(1, 1);
  g.rotateX(-Math.PI / 2);
  return g;
}

// ------------------------------------------------------------ material

export type Part = "body" | "head" | "face" | "ears" | "legs" | "tail" | "bow" | "bell" | "crown" | "shadow";

const HEAD_PARTS: Part[] = ["head", "face", "ears", "bow", "crown"];

const COMMON = /* glsl */ `
attribute vec4 iPos;    // x, y, z, yaw
attribute vec4 iPose;   // hop, squash, lie, roll
attribute vec4 iHead;   // pitch, yaw, roll, eyeOpen
attribute vec4 iMotion; // walkPhase, walkAmount, seed, earFlick
attribute vec4 iLook;   // scale, puff, earType, fade
attribute vec4 iAcc;    // bow, bell, crown, bowColour
attribute vec3 iWool;
attribute vec3 iFace;
uniform float uTime;
uniform vec3 uBow[5];
varying float vFade;

mat3 rotX(float a){ float c=cos(a), s=sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
mat3 rotY(float a){ float c=cos(a), s=sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotZ(float a){ float c=cos(a), s=sin(a); return mat3(c,s,0., -s,c,0., 0.,0.,1.); }

void sheepPose(inout vec3 p, inout vec3 n) {
  float scale = iLook.x;
  float lamb = clamp((1.0 - scale) / 0.4, 0.0, 1.0);
  float lie = iPose.z;
  float t = uTime + iMotion.z * 10.0;
  float walk = iMotion.y;

  #if defined(PART_HEAD)
    #ifdef PART_EARS
      // Ear shape (trait) and the occasional flick, about the ear root.
      float side = aEar.x;
      vec3 root = aEar.yzw;
      float type = iLook.z;
      float droop = type < 0.5 ? -0.95 : (type < 1.5 ? 0.28 : -0.3);
      float es = type > 1.5 ? 0.68 : 1.0;
      float flick = iMotion.w * sin(t * 30.0) * 0.45;
      float sway = walk * sin(iMotion.x * 2.0) * 0.18 + sin(t * 1.7) * 0.04;
      mat3 er = rotZ(side * (droop + flick + sway)) * rotY(side * -0.25);
      p = root + er * (p * es);
      n = er * n;
    #endif
    #ifdef PART_FACE
      // Blink by squashing the eye about its centre.
      if (aEye.w > 0.5) p.y = aEye.y + (p.y - aEye.y) * max(0.08, iHead.w);
    #endif
    #ifdef PART_BOW
      if (iAcc.x < 0.5) p *= 0.0;
    #endif
    #ifdef PART_CROWN
      if (iAcc.z < 0.5) p *= 0.0;
    #endif
    // Lambs have bigger heads. That is the whole trick.
    p *= 1.0 + lamb * 0.42;
    mat3 hr = rotY(iHead.y) * rotX(iHead.x) * rotZ(iHead.z);
    p = vec3(${NECK.x.toFixed(3)}, ${NECK.y.toFixed(3)}, ${NECK.z.toFixed(3)}) + hr * p;
    n = hr * n;
    // Head rides down with the body when lying.
    p.y -= lie * 0.36;
  #elif defined(PART_LEGS)
    vec3 hip = vec3(aLeg.x, 0.6, aLeg.y);
    float swing = sin(iMotion.x + aLeg.z) * 0.62 * walk;
    mat3 lr = rotX(swing);
    vec3 q = p - hip;
    q.y *= mix(1.0, 0.16, lie) * (1.0 + lamb * 0.15);
    p = hip + lr * q;
    n = lr * n;
    p.y += lamb * 0.06;
  #else
    #ifdef PART_TAIL
      vec3 tp = vec3(0.0, 1.0, -0.7);
      float wig = sin(t * 14.0) * (0.25 + 0.5 * step(0.7, fract(t * 0.21 + iMotion.z))) + walk * sin(iMotion.x) * 0.3;
      mat3 tr = rotY(wig);
      p = tp + tr * (p - tp);
    #endif
    #ifdef PART_BELL
      if (iAcc.y < 0.5) p *= 0.0;
    #endif
    #if defined(PART_BODY)
      // Breathing, puffier wool with level, and a sleepy slow heave.
      float breath = sin(t * mix(1.9, 1.05, lie)) * mix(0.018, 0.035, lie);
      float puff = iLook.y;
      vec3 c = vec3(0.0, 0.98, -0.04);
      p = c + (p - c) * vec3(1.0 + puff * 0.1 + breath, 1.0 + puff * 0.06 + breath * 1.4, 1.0 + puff * 0.07);
      // A woolly wobble when walking.
      p.y += abs(sin(iMotion.x)) * 0.05 * walk;
    #endif
    #ifndef PART_SHADOW
      p.y -= lie * 0.42;
      // Legs stay long on a lamb, so lift everything above them.
      p.y += lamb * 0.06;
    #endif
  #endif

  #ifdef PART_SHADOW
    // A soft blob under the sheep, shrinking as it hops.
    float hopK = clamp(1.0 - iPose.x * 0.35, 0.45, 1.0);
    p.x *= 1.55 * hopK * (1.0 + lie * 0.25);
    p.z *= 2.0 * hopK;
    p *= scale * (1.0 + iLook.y * 0.08);
    p.y = 0.05;
    mat3 yr = rotY(iPos.w);
    p = yr * p + iPos.xyz;
  #else
    // Squash and stretch about the feet.
    float sq = iPose.y;
    p.y *= sq;
    p.xz *= inversesqrt(sq);
    // Body roll (walk sway, petted lean).
    mat3 rr = rotZ(iPose.w);
    p = rr * p;
    n = rr * n;
    p *= scale;
    mat3 yr = rotY(iPos.w);
    p = yr * p + iPos.xyz + vec3(0.0, iPose.x, 0.0);
    n = yr * n;
  #endif
}
`;

const DITHER = /* glsl */ `
varying float vFade;
float bayer4(vec2 q) {
  ivec2 i = ivec2(mod(q, 4.0));
  int idx = i.x + i.y * 4;
  float m[16] = float[16](0.,8.,2.,10.,12.,4.,14.,6.,3.,11.,1.,9.,15.,7.,13.,5.);
  return (m[idx] + 0.5) / 16.0;
}
`;

export function sheepMaterial(part: Part, uniforms: { uTime: { value: number } }): THREE.Material {
  if (part === "shadow") {
    const m = new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uBow: { value: BOW.map((c) => new THREE.Color(c)) }, fogColor: { value: new THREE.Color() }, uNight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        #define PART_SHADOW
        ${COMMON}
        varying vec2 vUv;
        void main() {
          vUv = position.xz * 2.0;
          vec3 p = position; vec3 n = vec3(0.,1.,0.);
          sheepPose(p, n);
          vFade = iAcc.x;
          gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv;
        varying float vFade;
        void main() {
          float d = length(vUv);
          float a = smoothstep(1.0, 0.15, d) * 0.3 * vFade;
          gl_FragColor = vec4(0.16, 0.24, 0.1, a);
        }`,
    });
    return m;
  }

  const fixedColor = part === "face" || part === "bell" || part === "crown";
  const m = new THREE.MeshLambertMaterial({ vertexColors: true });
  m.defines = {
    [`PART_${part.toUpperCase()}`]: "",
    ...(HEAD_PARTS.includes(part) ? { PART_HEAD: "" } : {}),
    ...(fixedColor ? { PART_FIXED: "" } : {}),
  };
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uBow = { value: BOW.map((c) => new THREE.Color(c)) };
    const extra =
      part === "ears" ? "attribute vec4 aEar;\n" : part === "legs" ? "attribute vec3 aLeg;\n" : part === "face" ? "attribute vec4 aEye;\n" : "";
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${extra}${COMMON}\nvec3 gPosed; vec3 gNormal;`)
      .replace(
        "#include <beginnormal_vertex>",
        `gPosed = position; gNormal = normal; sheepPose(gPosed, gNormal); vec3 objectNormal = gNormal;
         #ifdef USE_TANGENT
         vec3 objectTangent = vec3(tangent.xyz);
         #endif`,
      )
      .replace("#include <begin_vertex>", "vec3 transformed = gPosed; vFade = iLook.w;")
      .replace(
        "#include <color_vertex>",
        `#if defined(PART_FIXED)
           vColor = color;
         #elif defined(PART_BOW)
           int bi = int(iAcc.w + 0.5);
           vColor = uBow[bi] * color.g;
         #else
           vColor = mix(iFace, iWool, color.r) * color.g;
         #endif`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${DITHER}`)
      .replace("void main() {", "void main() {\n  if (vFade < 0.995 && bayer4(gl_FragCoord.xy) >= vFade) discard;")
      // Felt: a soft bright rim, so wool reads as fuzzy rather than plastic.
      .replace(
        "#include <aomap_fragment>",
        `#include <aomap_fragment>
         {
           float rim = 1.0 - max(dot(normal, normalize(vViewPosition)), 0.0);
           reflectedLight.indirectDiffuse += diffuseColor.rgb * pow(rim, 2.2) * ${part === "body" || part === "tail" ? "0.42" : "0.16"};
         }`,
      );
  };
  // Different defines need different programs.
  m.customProgramCacheKey = () => `sheep-${part}`;
  return m;
}
