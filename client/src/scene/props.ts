// Scenery from the shared world map: trees, rocks, fences, low stone walls
// and ponds. All static, all instanced, toy-like and flat-shaded.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hash2, rng } from "../../../shared/rng";
import { POND_RIM, WORLD, terrainHeight, type Wall } from "../../../shared/world";

function colored(g: THREE.BufferGeometry, hex: string, jitter = 0, seed = 1) {
  const geo = g.index ? g.toNonIndexed() : g;
  geo.deleteAttribute("uv");
  const n = geo.getAttribute("position").count;
  const c = new THREE.Color(hex);
  const arr = new Float32Array(n * 3);
  const r = rng(seed);
  // Per-face jitter gives the faceted, hand-painted look.
  for (let i = 0; i < n; i += 3) {
    const k = 1 + (r() - 0.5) * jitter;
    for (let v = 0; v < 3; v++) arr.set([c.r * k, c.g * k, c.b * k], (i + v) * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function treeGeometry(kind: number): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.2, 0.32, 2.4, 7);
  trunk.translate(0, 1.2, 0);
  const parts = [colored(trunk, "#9a7150", 0.12, 3)];
  if (kind === 0) {
    // Round, cloud-like canopy.
    const blobs: [number, number, number, number][] = [
      [0, 3.3, 0, 1.75],
      [0.95, 2.85, 0.35, 1.2],
      [-0.85, 2.95, -0.2, 1.25],
      [0.1, 2.7, -0.95, 1.1],
      [-0.2, 4.15, 0.25, 1.05],
    ];
    blobs.forEach(([x, y, z, r], i) => {
      const g = new THREE.IcosahedronGeometry(r, 1);
      g.translate(x, y, z);
      parts.push(colored(g, i % 2 ? "#7cb862" : "#6fae58", 0.14, 10 + i));
    });
  } else if (kind === 1) {
    // Stacked cones, like a toy fir.
    [
      [2.1, 1.75, 2.0],
      [3.2, 1.4, 1.8],
      [4.2, 1.0, 1.5],
    ].forEach(([y, r, h], i) => {
      const g = new THREE.ConeGeometry(r, h, 8);
      g.translate(0, y, 0);
      parts.push(colored(g, i % 2 ? "#5f9f5e" : "#57975a", 0.12, 20 + i));
    });
  } else {
    // A tall, soft oval.
    const g = new THREE.IcosahedronGeometry(1, 1);
    g.scale(1.25, 1.9, 1.25);
    g.translate(0, 3.6, 0);
    parts.push(colored(g, "#8cc069", 0.14, 31));
    const g2 = new THREE.IcosahedronGeometry(0.8, 1);
    g2.translate(0.7, 2.7, 0.5);
    parts.push(colored(g2, "#81b862", 0.14, 32));
  }
  const geo = mergeGeometries(parts)!;
  geo.computeVertexNormals();
  return geo;
}

function lambert() {
  return new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
}

function shadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(30,50,20,0.38)");
  grd.addColorStop(0.6, "rgba(30,50,20,0.18)");
  grd.addColorStop(1, "rgba(30,50,20,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const tmp = new THREE.Object3D();

export class Props {
  readonly group = new THREE.Group();
  private water: THREE.ShaderMaterial;
  private treeMeshes: THREE.InstancedMesh[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const color = new THREE.Color();

    // Trees, one instanced mesh per shape.
    const shadows: { x: number; z: number; r: number }[] = [];
    for (let kind = 0; kind < 3; kind++) {
      const list = WORLD.trees.filter((t) => t.kind === kind);
      const mesh = new THREE.InstancedMesh(treeGeometry(kind), lambert(), list.length);
      list.forEach((t, i) => {
        tmp.position.set(t.x, terrainHeight(t.x, t.z) - 0.1, t.z);
        tmp.rotation.set(0, hash2(i, kind) * Math.PI * 2, 0);
        tmp.scale.setScalar(t.s);
        tmp.updateMatrix();
        mesh.setMatrixAt(i, tmp.matrix);
        mesh.setColorAt(i, color.setRGB(0.9 + hash2(i, kind, 3) * 0.18, 0.94 + hash2(i, kind, 4) * 0.1, 0.88 + hash2(i, kind, 5) * 0.14));
        shadows.push({ x: t.x + 0.6, z: t.z + 0.4, r: 3.1 * t.s });
      });
      mesh.computeBoundingSphere();
      this.group.add(mesh);
      this.treeMeshes.push(mesh);
    }

    // Rocks.
    {
      const g = new THREE.DodecahedronGeometry(1, 0);
      g.scale(1, 0.62, 0.85);
      const mesh = new THREE.InstancedMesh(colored(g, "#c4c1b8", 0.18, 7), lambert(), WORLD.rocks.length);
      WORLD.rocks.forEach((k, i) => {
        tmp.position.set(k.x, terrainHeight(k.x, k.z) + k.r * 0.18, k.z);
        tmp.rotation.set(hash2(i, 1) * 0.6, hash2(i, 2) * 6.28, hash2(i, 3) * 0.4);
        tmp.scale.setScalar(k.r);
        tmp.updateMatrix();
        mesh.setMatrixAt(i, tmp.matrix);
        const v = 0.9 + hash2(i, 4) * 0.2;
        mesh.setColorAt(i, color.setRGB(v, v, v * 0.97));
        if (k.r > 0.6) shadows.push({ x: k.x, z: k.z, r: k.r * 2 });
      });
      this.group.add(mesh);
    }

    this.addFences(WORLD.walls.filter((w) => w.kind === 0));
    this.addStoneWalls(WORLD.walls.filter((w) => w.kind === 1));

    // Blob shadows under scenery.
    {
      const g = new THREE.PlaneGeometry(1, 1);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false });
      const mesh = new THREE.InstancedMesh(g, m, shadows.length);
      shadows.forEach((s, i) => {
        tmp.position.set(s.x, terrainHeight(s.x, s.z) + 0.04, s.z);
        tmp.rotation.set(0, 0, 0);
        tmp.scale.set(s.r * 2, 1, s.r * 2);
        tmp.updateMatrix();
        mesh.setMatrixAt(i, tmp.matrix);
      });
      mesh.renderOrder = -3;
      this.group.add(mesh);
    }

    // Ponds.
    this.water = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      fog: true,
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uTime: { value: 0 }, uNight: { value: 0 }, uSky: { value: new THREE.Color("#bfe3f0") } },
      ]),
      vertexShader: /* glsl */ `
        #include <fog_pars_vertex>
        varying vec2 vLocal; varying vec3 vWorld;
        void main(){
          vLocal = position.xy;
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vec4 mvPosition = viewMatrix * w;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        #include <fog_pars_fragment>
        uniform float uTime; uniform float uNight; uniform vec3 uSky;
        varying vec2 vLocal; varying vec3 vWorld;
        void main(){
          float d = length(vLocal);
          vec3 deep = mix(vec3(0.36, 0.66, 0.78), vec3(0.12, 0.2, 0.36), uNight);
          vec3 edge = mix(vec3(0.62, 0.84, 0.86), vec3(0.22, 0.32, 0.48), uNight);
          vec3 col = mix(edge, deep, smoothstep(0.55, 0.05, 1.0 - d));
          // Soft travelling ripples and a few glints.
          float rip = sin(vWorld.x * 0.9 + uTime * 1.3) * sin(vWorld.z * 0.8 - uTime * 1.1);
          col += smoothstep(0.86, 1.0, rip) * mix(0.22, 0.12, uNight);
          col = mix(col, uSky, 0.12);
          float shore = smoothstep(1.0, 0.93, d);
          gl_FragColor = vec4(col, 0.92 * shore);
          #include <fog_fragment>
        }`,
    });
    const padGeo = new THREE.CircleGeometry(0.75, 14, 0.4, Math.PI * 2 - 0.5);
    padGeo.rotateX(-Math.PI / 2);
    const pads = new THREE.InstancedMesh(colored(padGeo, "#6fae5a", 0.1, 4), lambert(), WORLD.ponds.length * 8);
    const reedGeo = new THREE.ConeGeometry(0.06, 1.6, 4);
    reedGeo.translate(0, 0.8, 0);
    const reeds = new THREE.InstancedMesh(colored(reedGeo, "#5d8f4c", 0.15, 5), lambert(), WORLD.ponds.length * 40);
    let pi = 0;
    let ri = 0;
    WORLD.ponds.forEach((p, n) => {
      const disc = new THREE.Mesh(new THREE.CircleGeometry(p.r + 0.9, 64), this.water);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(p.x, POND_RIM + 0.05, p.z);
      // The shader wants coordinates in units of the radius.
      (disc.geometry as THREE.BufferGeometry).scale(1 / (p.r + 0.9), 1 / (p.r + 0.9), 1);
      disc.scale.set(p.r + 0.9, p.r + 0.9, 1);
      this.group.add(disc);
      for (let k = 0; k < 8; k++) {
        const a = hash2(n, k, 1) * Math.PI * 2;
        const d = p.r * (0.45 + hash2(n, k, 2) * 0.4);
        tmp.position.set(p.x + Math.cos(a) * d, POND_RIM + 0.08, p.z + Math.sin(a) * d);
        tmp.rotation.set(0, hash2(n, k, 3) * 6.28, 0);
        tmp.scale.setScalar(0.7 + hash2(n, k, 4) * 0.6);
        tmp.updateMatrix();
        pads.setMatrixAt(pi++, tmp.matrix);
      }
      for (let k = 0; k < 40; k++) {
        // Reeds in a few clumps around the edge.
        const clump = Math.floor(k / 8);
        const a = hash2(n, clump, 5) * Math.PI * 2 + (hash2(n, k, 6) - 0.5) * 0.25;
        const d = p.r + 0.2 + hash2(n, k, 7) * 1.2;
        const x = p.x + Math.cos(a) * d;
        const z = p.z + Math.sin(a) * d;
        tmp.position.set(x, terrainHeight(x, z) - 0.05, z);
        tmp.rotation.set((hash2(n, k, 8) - 0.5) * 0.3, 0, (hash2(n, k, 9) - 0.5) * 0.3);
        tmp.scale.set(1, 0.6 + hash2(n, k, 10) * 0.7, 1);
        tmp.updateMatrix();
        reeds.setMatrixAt(ri++, tmp.matrix);
      }
    });
    this.group.add(pads, reeds);
  }

  private addFences(walls: Wall[]) {
    const posts: THREE.Matrix4[] = [];
    const rails: THREE.Matrix4[] = [];
    for (const w of walls) {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const ang = Math.atan2(w.bz - w.az, w.bx - w.ax);
      const n = Math.max(2, Math.round(len / 2.4) + 1);
      for (let i = 0; i < n; i++) {
        const f = i / (n - 1);
        const x = w.ax + (w.bx - w.ax) * f;
        const z = w.az + (w.bz - w.az) * f;
        tmp.position.set(x, terrainHeight(x, z) + 0.5, z);
        tmp.rotation.set(0, -ang + (hash2(i, Math.round(x)) - 0.5) * 0.2, (hash2(i, Math.round(z)) - 0.5) * 0.08);
        tmp.scale.set(1, 1, 1);
        tmp.updateMatrix();
        posts.push(tmp.matrix.clone());
      }
      for (let i = 0; i < n - 1; i++) {
        const f0 = i / (n - 1);
        const f1 = (i + 1) / (n - 1);
        const x0 = w.ax + (w.bx - w.ax) * f0;
        const z0 = w.az + (w.bz - w.az) * f0;
        const x1 = w.ax + (w.bx - w.ax) * f1;
        const z1 = w.az + (w.bz - w.az) * f1;
        const y0 = terrainHeight(x0, z0);
        const y1 = terrainHeight(x1, z1);
        const seg = Math.hypot(x1 - x0, z1 - z0, y1 - y0);
        for (const h of [0.42, 0.78]) {
          tmp.position.set((x0 + x1) / 2, (y0 + y1) / 2 + h, (z0 + z1) / 2);
          tmp.rotation.set(0, -ang, Math.atan2(y1 - y0, Math.hypot(x1 - x0, z1 - z0)));
          tmp.scale.set(seg, 1, 1);
          tmp.updateMatrix();
          rails.push(tmp.matrix.clone());
        }
      }
    }
    const post = new THREE.BoxGeometry(0.17, 1.05, 0.17);
    const rail = new THREE.BoxGeometry(1, 0.1, 0.07);
    for (const [g, list, hex] of [
      [post, posts, "#b48d62"],
      [rail, rails, "#c49d70"],
    ] as const) {
      const mesh = new THREE.InstancedMesh(colored(g, hex, 0.12, 9), lambert(), list.length);
      list.forEach((m, i) => mesh.setMatrixAt(i, m));
      this.group.add(mesh);
    }
  }

  private addStoneWalls(walls: Wall[]) {
    const stones: THREE.Matrix4[] = [];
    const tints: number[] = [];
    let k = 0;
    for (const w of walls) {
      const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
      const ang = Math.atan2(w.bz - w.az, w.bx - w.ax);
      for (const row of [0, 1]) {
        const step = row ? 0.95 : 0.8;
        for (let d = row * 0.4; d < len; d += step) {
          const f = d / len;
          const x = w.ax + (w.bx - w.ax) * f;
          const z = w.az + (w.bz - w.az) * f;
          const s = 0.42 + hash2(k, 1) * 0.16;
          tmp.position.set(x, terrainHeight(x, z) + (row ? 0.62 : 0.24), z);
          tmp.rotation.set(hash2(k, 2) * 0.5, -ang + hash2(k, 3), hash2(k, 4) * 0.5);
          tmp.scale.set(s * 1.25, s * (row ? 0.75 : 0.85), s);
          tmp.updateMatrix();
          stones.push(tmp.matrix.clone());
          tints.push(0.88 + hash2(k, 5) * 0.2);
          k++;
        }
      }
    }
    const mesh = new THREE.InstancedMesh(colored(new THREE.DodecahedronGeometry(1, 0), "#bdb6a6", 0.16, 11), lambert(), stones.length);
    const c = new THREE.Color();
    stones.forEach((m, i) => {
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, c.setScalar(tints[i]));
    });
    this.group.add(mesh);
  }

  update(time: number, night: number, sky: THREE.Color) {
    this.water.uniforms.uTime.value = time;
    this.water.uniforms.uNight.value = night;
    this.water.uniforms.uSky.value.copy(sky);
  }
}
