// Day and night (PRD "World"): one shared clock, one in-world day per real
// hour. Night is a blue tint, a moon instead of a sun, and fireflies.

import * as THREE from "three";
import { nightAmount, sunHeight } from "../../../shared/clock";

const C = (h: string) => new THREE.Color(h);
const DAY = { sky: C("#fff4dc"), ground: C("#87ad62"), sun: C("#fff0d2"), fog: C("#bcd99c") };
const DUSK = { sky: C("#ffd2a8"), ground: C("#8a8f62"), sun: C("#ffb27a"), fog: C("#e4c69a") };
const NIGHT = { sky: C("#93a3cc"), ground: C("#2c3a58"), sun: C("#c6d2f5"), fog: C("#2b3858") };

export class Sky {
  readonly hemi = new THREE.HemisphereLight(0xffffff, 0x88aa66, 1.9);
  readonly sun = new THREE.DirectionalLight(0xffffff, 1.7);
  readonly fog: THREE.Fog;
  readonly fogColor = new THREE.Color();
  night = 0;

  constructor(private scene: THREE.Scene) {
    this.fog = new THREE.Fog(DAY.fog.getHex(), 200, 520);
    scene.fog = this.fog;
    scene.background = this.fogColor;
    scene.add(this.hemi, this.sun, this.sun.target);
  }

  update(now: number, target: THREE.Vector3, camDist: number) {
    const night = nightAmount(now);
    const s = sunHeight(now);
    // Warm light close to the horizon, on both sides of the night.
    const dusk = Math.max(0, 1 - Math.abs(s + 0.32) / 0.42) * (1 - night * 0.6);
    this.night = night;
    const mix = (k: "sky" | "ground" | "sun" | "fog", out: THREE.Color) =>
      out.copy(DAY[k]).lerp(DUSK[k], dusk).lerp(NIGHT[k], night);
    mix("sky", this.hemi.color);
    mix("ground", this.hemi.groundColor);
    mix("sun", this.sun.color);
    mix("fog", this.fogColor);
    this.fog.color.copy(this.fogColor);
    this.hemi.intensity = 1.9 - night * 0.95;
    this.sun.intensity = 1.7 - night * 1.25;
    // Sun (or moon) swings across the sky; always lights from the front-left a little.
    const a = Math.atan2(s, 0.6);
    this.sun.position.set(target.x - 40 * Math.cos(a), target.y + 60, target.z + 30 + 20 * Math.sin(a));
    this.sun.target.position.copy(target);
    this.fog.near = camDist * 1.4 + 60;
    this.fog.far = camDist * 2.6 + 260;
  }
}
