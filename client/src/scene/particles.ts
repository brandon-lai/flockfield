// Small billboards: sleep z's, hearts, sparkles, puffs, crumbs. One instanced
// draw with a canvas atlas.

import * as THREE from "three";

export type Kind = "z" | "heart" | "sparkle" | "puff" | "crumb" | "seed";
const CELLS: Kind[] = ["z", "heart", "sparkle", "puff", "crumb", "seed"];
const MAX = 600;

function atlas(): THREE.CanvasTexture {
  const S = 64;
  const c = document.createElement("canvas");
  c.width = S * CELLS.length;
  c.height = S;
  const g = c.getContext("2d")!;
  const at = (i: number) => i * S + S / 2;
  // z
  g.font = "900 46px Nunito, ui-rounded, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 8;
  g.strokeStyle = "rgba(70,90,150,0.55)";
  g.strokeText("z", at(0), 34);
  g.fillStyle = "#f4f7ff";
  g.fillText("z", at(0), 34);
  // heart
  g.save();
  g.translate(at(1), 34);
  g.fillStyle = "#ff7f9f";
  g.beginPath();
  g.moveTo(0, 18);
  g.bezierCurveTo(-30, -4, -16, -28, 0, -12);
  g.bezierCurveTo(16, -28, 30, -4, 0, 18);
  g.fill();
  g.fillStyle = "rgba(255,255,255,0.6)";
  g.beginPath();
  g.ellipse(-9, -9, 5, 3.5, -0.6, 0, Math.PI * 2);
  g.fill();
  g.restore();
  // sparkle
  g.save();
  g.translate(at(2), 32);
  g.fillStyle = "#ffe27a";
  g.beginPath();
  for (let k = 0; k < 8; k++) {
    const r = k % 2 ? 6 : 28;
    const a = (k / 8) * Math.PI * 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.fill();
  g.restore();
  // puff
  const grd = g.createRadialGradient(at(3), 32, 0, at(3), 32, 30);
  grd.addColorStop(0, "rgba(255,255,255,0.95)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(S * 3, 0, S, S);
  // crumb
  g.fillStyle = "#e9c46a";
  g.beginPath();
  g.arc(at(4), 32, 14, 0, Math.PI * 2);
  g.fill();
  // dandelion seed
  g.strokeStyle = "#ffffff";
  g.lineWidth = 3;
  for (let k = 0; k < 7; k++) {
    const a = -Math.PI / 2 + (k - 3) * 0.32;
    g.beginPath();
    g.moveTo(at(5), 44);
    g.lineTo(at(5) + Math.cos(a) * 22, 44 + Math.sin(a) * 22);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface P {
  kind: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  born: number;
  life: number;
  size: number;
  spin: number;
}

export class Particles {
  private list: P[] = [];
  private pos = new Float32Array(MAX * 4);
  private meta = new Float32Array(MAX * 4);
  private geo = new THREE.InstancedBufferGeometry();
  private aPos = new THREE.InstancedBufferAttribute(this.pos, 4);
  private aMeta = new THREE.InstancedBufferAttribute(this.meta, 4);

  constructor(scene: THREE.Scene) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.setAttribute("position", quad.getAttribute("position"));
    this.geo.setAttribute("uv", quad.getAttribute("uv"));
    this.geo.setIndex(quad.getIndex());
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aMeta.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute("iPos", this.aPos);
    this.geo.setAttribute("iMeta", this.aMeta);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { uMap: { value: atlas() } },
      vertexShader: /* glsl */ `
        attribute vec4 iPos; attribute vec4 iMeta; varying vec2 vUv; varying float vA;
        void main(){
          float c = cos(iMeta.z), s = sin(iMeta.z);
          vec2 q = mat2(c, -s, s, c) * position.xy * iPos.w;
          vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
          mv.xy += q;
          gl_Position = projectionMatrix * mv;
          vUv = vec2((uv.x + iMeta.x) / ${CELLS.length}.0, uv.y);
          vA = iMeta.y;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMap; varying vec2 vUv; varying float vA;
        void main(){ vec4 t = texture2D(uMap, vUv); gl_FragColor = vec4(t.rgb, t.a * vA); if (gl_FragColor.a < 0.01) discard; }`,
    });
    const mesh = new THREE.Mesh(this.geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;
    scene.add(mesh);
  }

  spawn(kind: Kind, x: number, y: number, z: number, o: Partial<Omit<P, "kind" | "x" | "y" | "z">> = {}) {
    if (this.list.length >= MAX) this.list.shift();
    this.list.push({
      kind: CELLS.indexOf(kind),
      x,
      y,
      z,
      vx: o.vx ?? 0,
      vy: o.vy ?? 0.5,
      vz: o.vz ?? 0,
      born: performance.now(),
      life: o.life ?? 1600,
      size: o.size ?? 0.5,
      spin: o.spin ?? 0,
    });
  }

  burst(kind: Kind, x: number, y: number, z: number, n: number, speed = 2, size = 0.4, life = 1100) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random();
      this.spawn(kind, x, y, z, {
        vx: Math.cos(a) * speed * (0.4 + Math.random() * 0.6),
        vz: Math.sin(a) * speed * (0.4 + Math.random() * 0.6),
        vy: speed * (0.5 + up),
        size: size * (0.6 + Math.random() * 0.6),
        life: life * (0.7 + Math.random() * 0.5),
        spin: (Math.random() - 0.5) * 4,
      });
    }
  }

  update(dt: number) {
    const now = performance.now();
    this.list = this.list.filter((p) => now - p.born < p.life);
    let n = 0;
    for (const p of this.list) {
      const age = (now - p.born) / p.life;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const k = CELLS[p.kind];
      if (k === "crumb" || k === "sparkle") p.vy -= 4 * dt;
      else {
        p.vx *= 1 - dt * 1.5;
        p.vz *= 1 - dt * 1.5;
      }
      // z's sway as they rise.
      const sway = k === "z" ? Math.sin(age * 9) * 0.25 * dt : 0;
      p.x += sway;
      const grow = k === "z" ? 0.6 + age * 0.8 : k === "heart" ? Math.min(1, age * 6) * (1 + 0.1 * Math.sin(age * 20)) : 1;
      const alpha = Math.min(1, age * 8) * (1 - Math.max(0, (age - 0.6) / 0.4));
      this.pos.set([p.x, p.y, p.z, p.size * grow], n * 4);
      this.meta.set([p.kind, alpha, p.spin * age, 0], n * 4);
      n++;
    }
    this.aPos.needsUpdate = true;
    this.aMeta.needsUpdate = true;
    this.geo.instanceCount = n;
  }
}
