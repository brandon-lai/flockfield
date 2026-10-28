// DOM overlay: level badge, sheep cards, the floating "This is your sheep."
// label, the one-time hint, and the status pill. Minimal and rounded, floating
// over the scene (PRD "Art direction").

import { FOODS, type Food, type You } from "../../shared/protocol";
import type { ClientSheep } from "./scene/pose";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const FOOD_UI: Record<Food, { icon: string; name: string }> = {
  clover: { icon: "☘️", name: "Clover" },
  dandelion: { icon: "🌼", name: "Dandelion" },
  apple: { icon: "🍎", name: "Apple slice" },
  carrot: { icon: "🥕", name: "Carrot" },
  hay: { icon: "🌾", name: "Hay bundle" },
};

const regionNames = (() => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return null;
  }
})();

export function countryLabel(code: string | null): { flag: string; name: string } {
  if (!code || code === "XX") return { flag: "🌍", name: "Somewhere on Earth" };
  const flag = String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
  let name = code;
  try {
    name = regionNames?.of(code) ?? code;
  } catch {
    // Unknown code; show it as-is.
  }
  return { flag, name };
}

export function together(secs: number): string {
  if (secs < 60) return "Just met";
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m} min together`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m together`;
  return `${Math.floor(h / 24)} days together`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class UI {
  readonly badge = $<HTMLButtonElement>("badge");
  readonly find = $<HTMLButtonElement>("btn-find");
  readonly soundBtn = $<HTMLButtonElement>("btn-sound");
  private card = $("card");
  private label = $("label");
  private hint = $("hint");
  private status = $("status");
  private cardFor: string | null = null;
  private cardTimer: ReturnType<typeof setInterval> | null = null;
  private lastYou: You | null = null;
  private note = "";
  private noteUntil = 0;
  onFeed: (f: Food) => void = () => {};
  onPet: () => void = () => {};
  onClose: () => void = () => {};
  offline = false;

  constructor() {
    $("btn-about").addEventListener("click", () => $<HTMLDialogElement>("about").showModal());
  }

  get openCard() {
    return this.cardFor;
  }

  doneLoading() {
    const l = $("loading");
    l.classList.add("gone");
    setTimeout(() => l.remove(), 800);
  }

  setStatus(text: string | null, warn = false) {
    this.status.hidden = !text;
    if (text) this.status.textContent = text;
    this.status.classList.toggle("warn", warn);
  }

  setYou(y: You, levelUp = false) {
    this.lastYou = y;
    this.badge.hidden = false;
    this.find.hidden = false;
    $("badge-num").textContent = String(y.level);
    $("badge-fill").style.width = `${Math.round((y.into / y.next) * 100)}%`;
    this.badge.setAttribute("aria-label", `Your sheep: level ${y.level}, ${y.into} of ${y.next} EXP to the next level`);
    if (levelUp) {
      this.badge.classList.remove("levelup");
      void this.badge.offsetWidth;
      this.badge.classList.add("levelup");
    }
    if (this.cardFor === y.sheepId) this.renderMine();
  }

  setSound(on: boolean) {
    this.soundBtn.setAttribute("aria-pressed", String(on));
    this.soundBtn.title = on ? "Sound on" : "Sound off";
  }

  flash(msg: string) {
    this.note = msg;
    this.noteUntil = performance.now() + 2600;
    if (this.cardFor && this.lastYou && this.cardFor === this.lastYou.sheepId) this.renderMine();
  }

  showCard(s: ClientSheep) {
    this.cardFor = s.id;
    if (this.cardTimer) clearInterval(this.cardTimer);
    this.cardTimer = null;
    if (s.mine) {
      this.card.classList.remove("small");
      this.renderMine();
      // Cooldowns tick down while the card is open.
      this.cardTimer = setInterval(() => this.renderTray(), 1000);
    } else {
      this.card.classList.add("small");
      const wild = s.country === null;
      const c = countryLabel(s.country);
      this.card.innerHTML = wild
        ? `<div class="card-head"><span class="flag">🌿</span><div><div class="card-title">A wild sheep</div><div class="card-sub">Nobody's sheep — yet. Level ${s.level}</div></div><button class="card-close" aria-label="Close">×</button></div>`
        : `<div class="card-head"><span class="flag" aria-hidden="true">${c.flag}</span><div><div class="card-title">${esc(c.name)}</div><div class="card-sub">Someone's sheep</div></div><span class="lvl-chip"><small>Lv</small><b>${s.level}</b></span><button class="card-close" aria-label="Close">×</button></div>`;
      this.bindClose();
    }
    this.card.hidden = false;
  }

  hideCard() {
    if (!this.cardFor) return;
    this.cardFor = null;
    this.card.hidden = true;
    if (this.cardTimer) clearInterval(this.cardTimer);
    this.cardTimer = null;
  }

  private bindClose() {
    this.card.querySelector(".card-close")?.addEventListener("click", () => {
      this.hideCard();
      this.onClose();
    });
  }

  private renderMine() {
    const y = this.lastYou;
    if (!y) return;
    const pct = Math.round((y.into / y.next) * 100);
    this.card.innerHTML = `
      <div class="card-head">
        <span class="lvl-chip"><small>Lv</small><b>${y.level}</b></span>
        <div><div class="card-title">Your sheep</div><div class="card-sub">${together(y.activeSeconds)}</div></div>
        <button class="card-close" aria-label="Close">×</button>
      </div>
      <span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${y.next}" aria-valuenow="${y.into}"><i style="width:${pct}%"></i></span>
      <div class="card-row"><span>${this.offline ? "Offline: no EXP here" : `${y.into} / ${y.next} EXP`}</span><span>${this.offline ? "" : `Level ${y.level + 1} next`}</span></div>
      <div class="tray">${FOODS.map((f) => `<button class="food" data-food="${f}" title="${FOOD_UI[f].name}" aria-label="Feed ${FOOD_UI[f].name}">${FOOD_UI[f].icon}</button>`).join("")}</div>
      <div class="tray-note"></div>
      <div class="actions"><button class="pill" data-pet>Pet ♥</button></div>`;
    this.card.querySelectorAll<HTMLButtonElement>(".food").forEach((b) => b.addEventListener("click", () => this.onFeed(b.dataset.food as Food)));
    this.card.querySelector("[data-pet]")!.addEventListener("click", () => this.onPet());
    this.bindClose();
    this.renderTray();
  }

  private renderTray() {
    const y = this.lastYou;
    if (!y || this.cardFor !== y.sheepId) return;
    const wait = Math.max(0, y.feedReadyAt - (Date.now() + (this.clockOffset ?? 0)));
    const note = this.card.querySelector<HTMLElement>(".tray-note");
    this.card.querySelectorAll<HTMLButtonElement>(".food").forEach((b) => (b.disabled = wait > 0));
    if (!note) return;
    if (performance.now() < this.noteUntil) note.textContent = this.note;
    else if (wait > 0) {
      const s = Math.ceil(wait / 1000);
      note.textContent = `Full for now — next snack in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    } else note.textContent = "Pick a snack";
  }
  clockOffset = 0;

  /** Position the floating label above a screen point, or hide it. */
  placeLabel(px: number | null, py = 0) {
    if (px === null) {
      this.label.hidden = true;
      return;
    }
    this.label.hidden = false;
    const w = this.label.offsetWidth;
    this.label.style.transform = `translate(${Math.round(px - w / 2)}px, ${Math.round(py - 46)}px)`;
  }

  fadeLabel() {
    this.label.classList.add("fade");
    setTimeout(() => {
      this.label.hidden = true;
      this.label.classList.remove("fade");
    }, 600);
  }

  showHint() {
    this.hint.hidden = false;
    setTimeout(() => this.hint.classList.add("fade"), 6500);
    setTimeout(() => (this.hint.hidden = true), 7400);
  }
}
