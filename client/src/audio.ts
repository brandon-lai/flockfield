// Ambient sound, all synthesised (no audio files to license or load):
// wind, birdsong by day, crickets at night, distant bleats, and your own
// sheep's baa. PRD: off by default on mobile; on desktop it fades in after the
// first interaction, because browsers block autoplay audio.

const PREF = "flock.sound";

export class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: GainNode | null = null;
  private wantOn: boolean;
  private timers: ReturnType<typeof setTimeout>[] = [];
  night = 0;
  onChange: (on: boolean) => void = () => {};

  constructor(mobile: boolean) {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(PREF);
    } catch {
      saved = null;
    }
    this.wantOn = saved ? saved === "on" : !mobile;
    const unlock = () => {
      if (this.wantOn) this.start();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    document.addEventListener("visibilitychange", () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else if (this.wantOn) void this.ctx.resume();
    });
  }

  get on() {
    return this.wantOn;
  }

  toggle() {
    this.wantOn = !this.wantOn;
    try {
      localStorage.setItem(PREF, this.wantOn ? "on" : "off");
    } catch {
      // Preference just won't persist.
    }
    if (this.wantOn) this.start();
    else this.fadeTo(0, 0.4);
    this.onChange(this.wantOn);
  }

  private fadeTo(v: number, secs: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(v, t + secs);
  }

  private start() {
    if (!this.ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!C) return;
      this.ctx = new C();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(this.ctx.destination);
      this.ambient = this.ctx.createGain();
      this.ambient.gain.value = 0.9;
      this.ambient.connect(this.master);
      this.wind();
      this.schedule();
    }
    void this.ctx.resume();
    // A gentle fade-in, never a blast.
    this.fadeTo(0.8, 3);
  }

  private noise(secs: number) {
    const ctx = this.ctx!;
    const b = ctx.createBuffer(1, ctx.sampleRate * secs, ctx.sampleRate);
    const d = b.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      // Brown-ish noise: softer than white.
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.2;
    }
    return b;
  }

  private wind() {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise(6);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 420;
    const g = ctx.createGain();
    g.gain.value = 0.16;
    // Slow gusts on both loudness and brightness.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lg = ctx.createGain();
    lg.gain.value = 0.08;
    lfo.connect(lg).connect(g.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.045;
    const lg2 = ctx.createGain();
    lg2.gain.value = 180;
    lfo2.connect(lg2).connect(lp.frequency);
    src.connect(lp).connect(g).connect(this.ambient!);
    src.start();
    lfo.start();
    lfo2.start();
  }

  private schedule() {
    const loop = (fn: () => void, min: number, max: number) => {
      const go = () => {
        if (this.ctx?.state === "running" && this.wantOn) fn();
        this.timers.push(setTimeout(go, (min + Math.random() * (max - min)) * 1000));
      };
      this.timers.push(setTimeout(go, min * 1000 * Math.random()));
    };
    loop(() => (this.night < 0.5 ? this.bird() : this.crickets()), 2.5, 9);
    loop(() => this.baa({ distant: true }), 9, 24);
  }

  private bird() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2400 + Math.random() * 1600;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.ambient!);
    for (let i = 0; i < notes; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      const s = t + i * (0.11 + Math.random() * 0.05);
      o.type = "sine";
      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.2), s);
      o.frequency.exponentialRampToValueAtTime(base * (0.75 + Math.random() * 0.6), s + 0.08);
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.035, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0005, s + 0.1);
      o.connect(g).connect(pan);
      o.start(s);
      o.stop(s + 0.12);
    }
  }

  private crickets() {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    pan.connect(this.ambient!);
    for (let i = 0; i < 3; i++) {
      for (let k = 0; k < 4; k++) {
        const s = t + i * 0.42 + k * 0.035;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 4400 + Math.random() * 300;
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(0.012, s + 0.006);
        g.gain.linearRampToValueAtTime(0, s + 0.025);
        o.connect(g).connect(pan);
        o.start(s);
        o.stop(s + 0.03);
      }
    }
  }

  /** A synthesised "baa": a buzzy voice through two vowel formants, with the bleat's wobble. */
  baa(o: { lamb?: boolean; distant?: boolean; happy?: boolean } = {}) {
    if (!this.ctx || !this.master || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const dur = (o.distant ? 0.7 : 0.6) + Math.random() * 0.25;
    const f0 = (o.lamb ? 410 : 270) * (0.92 + Math.random() * 0.16) * (o.happy ? 1.12 : 1);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(f0 * 1.08, t);
    osc.frequency.linearRampToValueAtTime(f0, t + 0.12);
    osc.frequency.linearRampToValueAtTime(f0 * 0.9, t + dur);
    // Pitch vibrato plus the quick amplitude flutter that makes a bleat a bleat.
    const vib = ctx.createOscillator();
    vib.frequency.value = 6.5;
    const vg = ctx.createGain();
    vg.gain.value = f0 * 0.03;
    vib.connect(vg).connect(osc.frequency);
    const am = ctx.createOscillator();
    am.frequency.value = 22;
    const ag = ctx.createGain();
    ag.gain.value = 0.35;
    const flutter = ctx.createGain();
    flutter.gain.value = 0.65;
    am.connect(ag).connect(flutter.gain);
    const f1 = ctx.createBiquadFilter();
    f1.type = "bandpass";
    f1.frequency.value = 850;
    f1.Q.value = 3;
    const f2 = ctx.createBiquadFilter();
    f2.type = "bandpass";
    f2.frequency.value = 1350;
    f2.Q.value = 4;
    const env = ctx.createGain();
    const peak = o.distant ? 0.05 : 0.32;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + 0.05);
    env.gain.setValueAtTime(peak, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    const out = ctx.createGain();
    out.gain.value = 1;
    const pan = ctx.createStereoPanner();
    pan.pan.value = o.distant ? Math.random() * 1.4 - 0.7 : 0;
    osc.connect(flutter);
    flutter.connect(f1).connect(env);
    flutter.connect(f2).connect(env);
    let tail: AudioNode = env;
    if (o.distant) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1100;
      env.connect(lp);
      tail = lp;
    }
    tail.connect(out).connect(pan).connect(o.distant ? this.ambient! : this.master);
    for (const n of [osc, vib, am]) {
      n.start(t);
      n.stop(t + dur + 0.05);
    }
  }

  crunch() {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    const b = ctx.createBuffer(1, ctx.sampleRate * 0.08, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    src.buffer = b;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    src.connect(hp).connect(g).connect(this.master!);
    src.start(t);
  }

  chime() {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    [784, 988, 1175, 1568].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      const s = t + i * 0.09;
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(0.09, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0005, s + 0.6);
      o.connect(g).connect(this.master!);
      o.start(s);
      o.stop(s + 0.65);
    });
  }

  pop() {
    if (!this.ctx || this.ctx.state !== "running") return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(520, t);
    o.frequency.exponentialRampToValueAtTime(180, t + 0.12);
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.14);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + 0.15);
  }
}
