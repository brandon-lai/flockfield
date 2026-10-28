// Ambient life: butterflies drifting near the camera, birds crossing in the
// day, fireflies at night. Purely cosmetic and local to each viewer, except
// the butterfly a sheep chases, which follows that sheep's play intent.

import * as THREE from "three";
import { terrainHeight } from "../../../shared/world";

const BUTTERFLIES = 16;
const PINNED = 8;
const FIREFLIES = 140;
const BIRDS = 5;

function wingGeometry() {
  // Two wings hinged on the body (x = 0). aSide flips the flap.
  const pos = [0, 0, 0.1, 0.42, 0, 0.26, 0.32, 0, -0.2, 0, 0, 0.1, -0.42, 0, 0.26, -0.32, 0, -0.2, 0, 0, -0.12, 0.26, 0, -0.32, 0, 0, 0.1, 0, 0, -0.12, -0.26, 0, -0.32, 0, 0, 0.1];
  const side = [1, 1, 1, -1, -1, -1, 1, 1, 1, -1, -1, -1];
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aSide", new THREE.Float32BufferAttribute(side, 1));
  return g;
}

export class Critters {
  private bfGeo = new THREE.InstancedBufferGeometry();
  private bfPos = new Float32Array((BUTTERFLIES + PINNED) * 4);
  private bfAttr = new THREE.InstancedBufferAttribute(this.bfPos, 4);
  private pinned: [number, number, number, number][] = [];
  private flies: THREE.Points;
  private flyMat: THREE.ShaderMaterial;
  private birds: THREE.InstancedMesh;
  private birdMat: THREE.ShaderMaterial;
  private uTime = { value: 0 };
  private birdRun = { start: -1e9, from: new THREE.Vector3(), dir: new THREE.Vector3() };

  constructor(scene: THREE.Scene) {
    const w = wingGeometry();
    this.bfGeo.setAttribute("position", w.getAttribute("position"));
    this.bfGeo.setAttribute("aSide", w.getAttribute("aSide"));
    this.bfAttr.setUsage(THREE.DynamicDrawUsage);
    this.bfGeo.setAttribute("iPos", this.bfAttr);
    const bfMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      uniforms: { uTime: this.uTime },
      vertexShader: /* glsl */ `
        attribute float aSide; attribute vec4 iPos; uniform float uTime; varying vec3 vC;
        void main(){
          float flap = sin(uTime * 18.0 + iPos.w * 7.0) * 0.9;
          vec3 p = position;
          float a = aSide * flap;
          p.y = abs(p.x) * sin(a); p.x = p.x * cos(a);
          float h = iPos.w * 6.283;
          p.xz = mat2(cos(h), -sin(h), sin(h), cos(h)) * p.xz;
          gl_Position = projectionMatrix * viewMatrix * vec4(p * 0.9 + iPos.xyz, 1.0);
          vec3 pal[4] = vec3[4](vec3(1.0,0.86,0.42), vec3(1.0,1.0,0.96), vec3(0.98,0.68,0.8), vec3(0.62,0.76,1.0));
          vC = pal[int(mod(iPos.w * 37.0, 4.0))];
        }`,
      fragmentShader: `varying vec3 vC; void main(){ gl_FragColor = vec4(vC, 1.0); }`,
    });
    const bf = new THREE.Mesh(this.bfGeo, bfMat);
    bf.frustumCulled = false;
    scene.add(bf);

    // Fireflies: points with a soft glow, scattered around the camera target.
    const fp = new Float32Array(FIREFLIES * 3);
    for (let i = 0; i < FIREFLIES; i++) fp.set([Math.random(), Math.random(), Math.random()], i * 3);
    const fg = new THREE.BufferGeometry();
    fg.setAttribute("position", new THREE.BufferAttribute(fp, 3));
    this.flyMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: this.uTime, uNight: { value: 0 }, uCenter: { value: new THREE.Vector3() }, uSpread: { value: 60 }, uPx: { value: 1 } },
      vertexShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCenter; uniform float uSpread; uniform float uPx; varying float vA; uniform float uNight;
        void main(){
          vec3 r = position;
          vec2 base = (r.xz - 0.5) * uSpread * 2.0;
          // Wrap so fireflies stay around the camera without visibly jumping.
          vec2 cell = floor((uCenter.xz - base) / (uSpread * 2.0) + 0.5) * uSpread * 2.0;
          vec2 xz = base + cell + vec2(sin(uTime * 0.3 + r.y * 40.0), cos(uTime * 0.27 + r.x * 30.0)) * 2.5;
          float y = 0.8 + r.y * 2.2 + sin(uTime * 0.8 + r.z * 20.0) * 0.4;
          vec4 mv = viewMatrix * vec4(xz.x, uCenter.y + y, xz.y, 1.0);
          gl_Position = projectionMatrix * mv;
          float blink = smoothstep(0.2, 1.0, sin(uTime * (1.2 + r.z) + r.x * 50.0));
          vA = blink * uNight;
          gl_PointSize = uPx * 1100.0 / -mv.z;
        }`,
      fragmentShader: /* glsl */ `
        varying float vA;
        void main(){ float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); a = a * a * 0.7 + smoothstep(0.12, 0.0, d); gl_FragColor = vec4(1.0, 0.93, 0.55, a * vA); }`,
    });
    this.flies = new THREE.Points(fg, this.flyMat);
    this.flies.frustumCulled = false;
    scene.add(this.flies);

    // Birds: small chevrons that cross high above now and then.
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0.3, -1, 0, -0.3, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 1, 0, -0.3], 3));
    this.birdMat = new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: true,
      uniforms: { uTime: this.uTime, uA: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uTime;
        void main(){
          vec3 p = position;
          p.y = abs(p.x) * sin(uTime * 9.0 + float(gl_InstanceID) * 1.7) * 0.6;
          gl_Position = projectionMatrix * viewMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: `uniform float uA; void main(){ gl_FragColor = vec4(0.27, 0.3, 0.32, uA); }`,
    });
    this.birds = new THREE.InstancedMesh(bg, this.birdMat, BIRDS);
    this.birds.frustumCulled = false;
    scene.add(this.birds);
  }

  /** A butterfly at a given spot this frame (a sheep is chasing it). */
  pin(x: number, y: number, z: number, seed: number) {
    if (this.pinned.length < PINNED) this.pinned.push([x, y, z, seed]);
  }

  update(time: number, target: THREE.Vector3, night: number, camDist: number, px: number) {
    this.uTime.value = time;
    let n = 0;
    const day = 1 - night;
    if (day > 0.3) {
      for (let i = 0; i < BUTTERFLIES; i++) {
        // A slow wander in a loose ring around whatever the camera is looking at.
        const t = time * 0.05 + i * 13.1;
        const r = 10 + (i % 5) * 7;
        const x = Math.round(target.x / 40) * 40 + Math.sin(t * 1.3 + i) * r + Math.sin(t * 3.1) * 3;
        const z = Math.round(target.z / 40) * 40 + Math.cos(t * 0.9 + i * 2) * r + Math.cos(t * 2.3) * 3;
        const y = terrainHeight(x, z) + 1 + Math.abs(Math.sin(time * 1.7 + i)) * 0.9;
        this.bfPos.set([x, y, z, ((i * 0.618) % 1) + Math.sin(time * 0.5 + i) * 0.05], n++ * 4);
      }
    }
    for (const [x, y, z, seed] of this.pinned) this.bfPos.set([x, terrainHeight(x, z) + y, z, (seed % 100) / 100], n++ * 4);
    this.pinned.length = 0;
    this.bfAttr.needsUpdate = true;
    this.bfGeo.instanceCount = n;

    this.flyMat.uniforms.uNight.value = Math.max(0, night - 0.2) / 0.8;
    this.flyMat.uniforms.uCenter.value.set(target.x, terrainHeight(target.x, target.z), target.z);
    this.flyMat.uniforms.uSpread.value = Math.max(30, Math.min(120, camDist * 0.6));
    this.flyMat.uniforms.uPx.value = px;

    // Every minute or so in daylight, a few birds cross the view.
    const b = this.birdRun;
    const elapsed = time - b.start;
    if (elapsed > 50 && day > 0.6 && Math.random() < 0.002) {
      b.start = time;
      const a = Math.random() * Math.PI * 2;
      b.dir.set(Math.cos(a), 0, Math.sin(a));
      b.from.copy(target).addScaledVector(b.dir, -camDist * 1.6);
      b.from.y = Math.min(60, 14 + camDist * 0.25);
    }
    const flying = elapsed < 30;
    this.birdMat.uniforms.uA.value = flying ? Math.min(1, elapsed, 30 - elapsed) * 0.75 * day : 0;
    const m = new THREE.Object3D();
    for (let i = 0; i < BIRDS; i++) {
      const p = b.from.clone().addScaledVector(b.dir, elapsed * 9 + (i % 2 ? -i : i) * 1.2);
      p.x += -b.dir.z * (i - 2) * 1.6;
      p.z += b.dir.x * (i - 2) * 1.6;
      m.position.copy(p);
      m.lookAt(p.clone().add(b.dir));
      m.scale.setScalar(flying ? 0.9 : 0);
      m.updateMatrix();
      this.birds.setMatrixAt(i, m.matrix);
    }
    this.birds.instanceMatrix.needsUpdate = true;
  }
}
