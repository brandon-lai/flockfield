// Draws the flock: two instanced batches (near: every part and a face; far:
// a wool blob and a head) plus soft shadows and the glow ring under your own
// sheep. Sheep moving between the two cross-fade with a screen-door dither so
// level of detail never pops (PRD "Level of detail").

import * as THREE from "three";
import { ACCESSORY_LEVELS, fluffTier, isLamb } from "../../../shared/levels";
import { FACE, WOOL, WOOL_KEYS } from "../../../shared/traits";
import type { ClientSheep } from "./pose";
import * as M from "./sheepModel";

/** Most sheep drawn per frame; the farthest fade out (PRD suggests 1,500). */
export const RENDER_CAP = 1500;
const NEAR_CAP = 320;
/** Projected body height (px) at which a sheep gets its face; cross-fade across the band. */
const NEAR_PX_IN = 30;
const NEAR_PX_OUT = 20;

const STRIDE = { iPos: 4, iPose: 4, iHead: 4, iMotion: 4, iLook: 4, iAcc: 4, iWool: 3, iFace: 3 } as const;
type AttrName = keyof typeof STRIDE;

class Batch {
  count = 0;
  readonly arrays = {} as Record<AttrName, Float32Array>;
  readonly attrs = {} as Record<AttrName, THREE.InstancedBufferAttribute>;
  readonly meshes: THREE.Mesh[] = [];
  readonly geos: THREE.InstancedBufferGeometry[] = [];

  constructor(
    readonly cap: number,
    parts: [M.Part, THREE.BufferGeometry][],
    uniforms: { uTime: { value: number } },
    scene: THREE.Scene,
    far = false,
  ) {
    for (const k of Object.keys(STRIDE) as AttrName[]) {
      this.arrays[k] = new Float32Array(cap * STRIDE[k]);
      this.attrs[k] = new THREE.InstancedBufferAttribute(this.arrays[k], STRIDE[k]);
      this.attrs[k].setUsage(THREE.DynamicDrawUsage);
    }
    for (const [part, g] of parts) {
      const geo = new THREE.InstancedBufferGeometry();
      for (const [name, a] of Object.entries(g.attributes)) geo.setAttribute(name, a);
      if (g.index) geo.setIndex(g.index);
      for (const k of Object.keys(STRIDE) as AttrName[]) geo.setAttribute(k, this.attrs[k]);
      geo.instanceCount = 0;
      const mesh = new THREE.Mesh(geo, M.sheepMaterial(part, uniforms, far));
      mesh.frustumCulled = false;
      mesh.renderOrder = part === "shadow" ? -1 : 0;
      scene.add(mesh);
      this.meshes.push(mesh);
      this.geos.push(geo);
    }
  }

  write(s: ClientSheep, fade: number, colors: (s: ClientSheep) => [THREE.Color, THREE.Color]) {
    if (this.count >= this.cap) return;
    const n = this.count++;
    const a = this.arrays;
    const p = s.pose;
    const lamb = isLamb(s.level);
    const scale = lamb ? 0.6 + Math.min(4, s.level - 1) * 0.03 : 1 + Math.min(6, fluffTier(s.level) - 1) * 0.02;
    const puff = s.traits.puff * 0.7 + (lamb ? 0 : fluffTier(s.level) * 0.22);
    a.iPos.set([s.x, s.y, s.z, Math.PI / 2 - s.heading], n * 4);
    a.iPose.set([p.hop, p.squash, p.lie, p.roll], n * 4);
    a.iHead.set([p.pitch, p.yaw, p.hroll, p.eye], n * 4);
    a.iMotion.set([s.walkPhase, s.walkAmt, (s.traits.seed % 1000) / 1000, p.flick], n * 4);
    a.iLook.set([scale, puff, s.traits.ears, fade], n * 4);
    a.iAcc.set(
      [
        s.level >= ACCESSORY_LEVELS.bow ? 1 : 0,
        s.level >= ACCESSORY_LEVELS.bell ? 1 : 0,
        s.level >= ACCESSORY_LEVELS.crown ? 1 : 0,
        s.traits.bow,
      ],
      n * 4,
    );
    const [w, f] = colors(s);
    a.iWool.set([w.r, w.g, w.b], n * 3);
    a.iFace.set([f.r, f.g, f.b], n * 3);
  }

  flush() {
    for (const k of Object.keys(STRIDE) as AttrName[]) {
      const at = this.attrs[k];
      at.clearUpdateRanges();
      at.addUpdateRange(0, this.count * STRIDE[k]);
      at.needsUpdate = true;
    }
    for (const g of this.geos) g.instanceCount = this.count;
  }
}

const woolColors = WOOL_KEYS.map((k) => new THREE.Color(WOOL[k]));
const faceColors = FACE.map((c) => new THREE.Color(c));
const colorsOf = (s: ClientSheep): [THREE.Color, THREE.Color] => [
  woolColors[s.traits.wool] ?? woolColors[0],
  faceColors[s.traits.face] ?? faceColors[0],
];

export class SheepRenderer {
  readonly uniforms = { uTime: { value: 0 } };
  private near: Batch;
  private far: Batch;
  private ring: THREE.Mesh;
  private ringMat: THREE.ShaderMaterial;
  private frustum = new THREE.Frustum();
  private m4 = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private v = new THREE.Vector3();
  /** What was drawn last frame, with screen positions, for picking. */
  drawn: { s: ClientSheep; px: number; py: number; r: number; dist: number }[] = [];
  nearIds = new Set<string>();

  constructor(scene: THREE.Scene) {
    this.near = new Batch(
      NEAR_CAP,
      [
        ["body", M.bodyGeometry()],
        ["head", M.headGeometry()],
        ["face", M.faceGeometry()],
        ["ears", M.earsGeometry()],
        ["legs", M.legsGeometry()],
        ["tail", M.tailGeometry()],
        ["bow", M.bowGeometry()],
        ["bell", M.bellGeometry()],
        ["crown", M.crownGeometry()],
      ],
      this.uniforms,
      scene,
    );
    this.far = new Batch(
      RENDER_CAP,
      [
        ["shadow", M.shadowGeometry()],
        ["body", M.farBodyGeometry()],
        ["head", M.farHeadGeometry()],
      ],
      this.uniforms,
      scene,
      true,
    );

    this.ringMat = new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uNight: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv * 2.0 - 1.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        varying vec2 vUv; uniform float uTime; uniform float uNight;
        void main(){
          float d = length(vUv);
          float pulse = 0.5 + 0.5 * sin(uTime * 2.2);
          float ring = smoothstep(0.62, 0.8, d) * (1.0 - smoothstep(0.8, 1.0, d));
          float glow = (1.0 - smoothstep(0.0, 1.0, d)) * 0.35;
          vec3 col = mix(vec3(1.0, 0.93, 0.62), vec3(1.0, 0.96, 0.8), uNight);
          gl_FragColor = vec4(col, (ring * (0.75 + 0.25 * pulse) + glow * (0.6 + 0.4 * pulse)) * mix(0.85, 1.0, uNight));
        }`,
    });
    const rg = new THREE.PlaneGeometry(3.4, 3.4);
    rg.rotateX(-Math.PI / 2);
    this.ring = new THREE.Mesh(rg, this.ringMat);
    this.ring.renderOrder = -2;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  /**
   * Choose what to draw and write it. Returns the sheep in the near band so
   * the caller can spend effort (particles, labels) only on those.
   */
  render(all: Iterable<ClientSheep>, camera: THREE.PerspectiveCamera, viewH: number, now: number, night: number) {
    this.uniforms.uTime.value = now / 1000;
    this.ringMat.uniforms.uNight.value = night;
    this.m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.m4);
    const focal = viewH / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));

    const vis: { s: ClientSheep; dist: number }[] = [];
    let mine: ClientSheep | null = null;
    for (const s of all) {
      if (s.mine) mine = s;
      this.sphere.center.set(s.x, s.y + 1, s.z);
      this.sphere.radius = 2.5;
      if (!this.frustum.intersectsSphere(this.sphere)) continue;
      vis.push({ s, dist: camera.position.distanceTo(this.sphere.center) });
    }
    vis.sort((a, b) => a.dist - b.dist);
    if (vis.length > RENDER_CAP) vis.length = RENDER_CAP;

    this.near.count = 0;
    this.far.count = 0;
    this.drawn.length = 0;
    this.nearIds.clear();
    const fadeStart = RENDER_CAP * 0.85;
    for (let k = 0; k < vis.length; k++) {
      const { s, dist } = vis[k];
      // Appear and leave softly.
      let life = Math.min(1, (now - s.bornAt) / 450);
      if (s.leaveAt) life *= Math.max(0, 1 - (now - s.leaveAt) / 450);
      // The farthest of a huge crowd thin out instead of vanishing at the cap.
      if (k > fadeStart) life *= 1 - (k - fadeStart) / (RENDER_CAP - fadeStart);
      const size = isLamb(s.level) ? 1.05 : 1.55;
      const px = (size * focal) / dist;
      let nearW = Math.min(1, Math.max(0, (px - NEAR_PX_OUT) / (NEAR_PX_IN - NEAR_PX_OUT)));
      if (this.near.count >= NEAR_CAP) nearW = 0;
      if (nearW > 0) {
        this.near.write(s, nearW * life, colorsOf);
        this.nearIds.add(s.id);
      }
      // The far batch always holds the shadow; its blob body fades as the near one appears.
      // The far batch holds every sheep: shadow (fade in iAcc.x), and a blob that
      // skips the dither cells the near batch draws (iAcc.y). Far parts never
      // use the accessory flags, so those slots are free.
      if (nearW < 0.999) {
        this.far.write(s, life, colorsOf);
        const o = (this.far.count - 1) * 4;
        this.far.arrays.iAcc[o] = life;
        this.far.arrays.iAcc[o + 1] = nearW;
      } else {
        this.far.write(s, 0, colorsOf);
        const o = (this.far.count - 1) * 4;
        this.far.arrays.iAcc[o] = life;
        this.far.arrays.iAcc[o + 1] = 1;
      }
      this.v.set(s.x, s.y + 0.9 * (size / 1.55), s.z).project(camera);
      this.drawn.push({ s, px: this.v.x, py: this.v.y, r: px, dist });
    }
    this.near.flush();
    this.far.flush();

    if (mine) {
      this.ring.visible = true;
      const scale = isLamb(mine.level) ? 0.7 : 1;
      this.ring.position.set(mine.x, mine.y + 0.06, mine.z);
      this.ring.scale.setScalar(scale * (1 + mine.pose.lie * 0.15));
    } else this.ring.visible = false;
  }
}
