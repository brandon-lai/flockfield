// The five foods (PRD "Feeding and petting"). A food is part of the eat
// intent, so every viewer of that sheep sees it drop, get eaten bite by bite,
// and disappear.

import * as THREE from "three";
import type { Food, Intent } from "../../../shared/protocol";
import { walkMs } from "../../../shared/sim";
import { terrainHeight } from "../../../shared/world";

const mat = (hex: string) => new THREE.MeshLambertMaterial({ color: hex, flatShading: true });
const M = {
  leaf: mat("#5fae4e"),
  flower: mat("#fffaf0"),
  stem: mat("#6fa253"),
  yellow: mat("#ffd23f"),
  skin: mat("#e0474c"),
  flesh: mat("#fff1cf"),
  carrot: mat("#f28c28"),
  top: mat("#4f9a3e"),
  hay: mat("#e8c96a"),
  band: mat("#b5894a"),
};

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
}

/** Each food is a group of `body` (eaten) and optionally `rest` (left behind, like a carrot top). */
function build(kind: Food): { root: THREE.Group; body: THREE.Group; rest: THREE.Group } {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const rest = new THREE.Group();
  root.add(body, rest);
  switch (kind) {
    case "clover":
      for (let i = 0; i < 3; i++) {
        const l = mesh(new THREE.SphereGeometry(0.17, 8, 6), M.leaf);
        const a = (i / 3) * Math.PI * 2;
        l.scale.set(1, 0.25, 0.8);
        l.position.set(Math.cos(a) * 0.17, 0.12, Math.sin(a) * 0.17);
        body.add(l);
      }
      body.add(mesh(new THREE.IcosahedronGeometry(0.09, 1), M.flower, 0, 0.24, 0));
      break;
    case "dandelion":
      body.add(mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.4, 5), M.stem, 0, 0.2, 0));
      body.add(mesh(new THREE.IcosahedronGeometry(0.17, 1), M.yellow, 0, 0.44, 0));
      break;
    case "apple": {
      const skin = mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.14, 12, 1, false, 0, Math.PI), M.skin, 0, 0.08, 0);
      skin.rotation.x = Math.PI / 2;
      const flesh = mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.145, 12, 1, false, 0, Math.PI), M.flesh, 0, 0.09, 0);
      flesh.rotation.x = Math.PI / 2;
      body.add(skin, flesh);
      break;
    }
    case "carrot": {
      const c = mesh(new THREE.ConeGeometry(0.11, 0.62, 8), M.carrot, 0, 0.1, 0);
      c.rotation.z = Math.PI / 2;
      body.add(c);
      for (let i = 0; i < 3; i++) {
        const t = mesh(new THREE.ConeGeometry(0.035, 0.3, 4), M.top, -0.36, 0.14, (i - 1) * 0.06);
        t.rotation.z = Math.PI / 2 + 0.5 + (i - 1) * 0.3;
        rest.add(t);
      }
      break;
    }
    case "hay": {
      const h = mesh(new THREE.CylinderGeometry(0.26, 0.3, 0.42, 9), M.hay, 0, 0.21, 0);
      const b = mesh(new THREE.TorusGeometry(0.29, 0.035, 5, 14), M.band, 0, 0.21, 0);
      b.rotation.x = Math.PI / 2;
      body.add(h, b);
      for (let i = 0; i < 6; i++) {
        const s = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 3), M.hay, Math.cos(i) * 0.2, 0.45, Math.sin(i) * 0.2);
        s.rotation.set(Math.sin(i * 3) * 0.6, 0, Math.cos(i * 2) * 0.6);
        body.add(s);
      }
      break;
    }
  }
  return { root, body, rest };
}

const BITES: Record<Food, number> = { clover: 3, dandelion: 2, apple: 3, carrot: 5, hay: 6 };
/** A carrot top lingers on the grass a little while after the carrot is gone. */
const LINGER = 3500;

interface Live {
  key: string;
  intent: Intent;
  parts: ReturnType<typeof build>;
}

export class Foods {
  private live = new Map<string, Live>();
  constructor(private scene: THREE.Scene) {}

  /** `intents`: the current intent of every known sheep. */
  update(intents: Iterable<Intent>, t: number) {
    const want = new Set<string>();
    for (const i of intents) {
      if (i.state !== "eat" || !i.food) continue;
      const end = i.startAt + i.duration;
      if (t > end + LINGER) continue;
      const key = `${i.id}:${i.startAt}`;
      want.add(key);
      let l = this.live.get(key);
      if (!l) {
        l = { key, intent: i, parts: build(i.food.kind) };
        l.parts.root.rotation.y = (i.variant % 628) / 100;
        this.scene.add(l.parts.root);
        this.live.set(key, l);
      }
      const { root, body, rest } = l.parts;
      const ground = terrainHeight(i.food.x, i.food.z);
      // Drops in from a little above the grass.
      const since = (t - i.startAt) / 1000;
      const fall = Math.max(0, 1 - since / 0.35);
      root.position.set(i.food.x, ground + fall * fall * 1.6, i.food.z);
      root.scale.setScalar(1.5);
      const eatStart = i.startAt + walkMs(i);
      const f = Math.min(1, Math.max(0, (t - eatStart) / (end - eatStart)));
      const bites = BITES[i.food.kind];
      const left = t >= end ? 0 : 1 - Math.floor(f * bites) / bites;
      body.scale.setScalar(left > 0 ? 0.35 + 0.65 * left : 0);
      body.visible = left > 0;
      rest.visible = t < end + LINGER;
      rest.scale.setScalar(t > end ? Math.max(0.01, 1 - (t - end) / LINGER) : 1);
    }
    for (const [k, l] of this.live) {
      if (want.has(k)) continue;
      this.scene.remove(l.parts.root);
      this.live.delete(k);
    }
  }
}
