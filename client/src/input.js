// Unified input source. Desktop: keyboard + mouse. Mobile: touch sticks + buttons.
// Output state: { mv:{x,y}, sprint, jump, block, attackTrigger,
//                 cameraYawDelta, cameraPitchDelta, zoomDelta }
//
// Desktop bindings:
//   WASD          movement
//   mouse         camera (no second-stick aim)
//   LMB           swingR
//   MMB           swingL
//   RMB (hold)    block
//   Wheel down    overhead
//   Wheel up      stab
//   Space         jump
//   Shift         sprint
//   F             block (alt)
//
// Mobile bindings (landscape):
//   left stick    movement
//   right stick   camera
//   4 buttons     swingL / swingR / overhead / stab
//   action btns   jump / sprint / block

import { CLIENT } from "./config.js";

export class Input {
  constructor() {
    this.mv = { x: 0, y: 0 };
    this.sprint = false;
    this.jump = false;          // edge: consumed each tick
    this.block = false;
    this.cameraYawDelta = 0;
    this.cameraPitchDelta = 0;
    this.zoomDelta = 0;         // unused on desktop now (wheel = attacks). Kept for future.
    this.touchActive = false;
    this._attackQueued = null;  // "swingL"|"swingR"|"overhead"|"stab"|null
    this._wheelLatch = 0;       // ms timestamp; rate-limit wheel attacks
    this._rmbDown = false;      // RMB hold = block

    this._keys = new Set();
    this._pointerLocked = false;

    this._installKeyboard();
    this._installMouse();
    this._installTouch();
  }

  _installKeyboard() {
    window.addEventListener("keydown", (e) => {
      if (e.repeat) return;
      this._keys.add(e.code);
      if (e.code === "Space") this.jump = true;
    });
    window.addEventListener("keyup", (e) => {
      this._keys.delete(e.code);
    });
    window.addEventListener("blur", () => { this._keys.clear(); this._rmbDown = false; });
  }

  _installMouse() {
    document.addEventListener("pointerlockchange", () => {
      this._pointerLocked = document.pointerLockElement != null;
    });
    const tryLock = () => {
      if (this.touchActive) return;
      if (this._pointerLocked) return;
      const canvas = document.querySelector("#app canvas");
      if (canvas && canvas.requestPointerLock) {
        try { canvas.requestPointerLock(); } catch {}
      }
    };
    window.addEventListener("mousedown", (e) => {
      if (this.touchActive) return;
      if (this._pointerLocked) {
        if (e.button === 0)      this._attackQueued = "swingR";   // LMB
        else if (e.button === 1) this._attackQueued = "swingL";   // MMB
        else if (e.button === 2) this._rmbDown = true;            // RMB hold = block
      } else {
        const tag = (e.target && e.target.tagName) || "";
        const onCanvas = e.target && e.target.tagName === "CANVAS";
        if (onCanvas && tag !== "INPUT" && tag !== "BUTTON" && tag !== "LABEL") tryLock();
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 2) this._rmbDown = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (!this._pointerLocked) return;
      const sens = ((window.IRONYARD_SETTINGS && window.IRONYARD_SETTINGS.sens) || 60) / 100;
      const dx = (e.movementX || 0) * sens;
      const dy = (e.movementY || 0) * sens;
      this.cameraYawDelta   += dx * 0.0020;
      this.cameraPitchDelta += dy * 0.0014;
    });
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    // Wheel: down = overhead, up = stab. Rate-limited to one trigger per 200ms so a
    // fast scroll doesn't queue a flurry of swings.
    window.addEventListener("wheel", (e) => {
      if (!this._pointerLocked) return;
      const now = performance.now();
      if (now - this._wheelLatch < 200) return;
      this._wheelLatch = now;
      if (e.deltaY > 0) this._attackQueued = "overhead";
      else if (e.deltaY < 0) this._attackQueued = "stab";
    }, { passive: true });
  }

  _installTouch() {
    // Two sticks: movement (left), camera (right). Compact so attack pad fits.
    const stickL = makeStick("stick-left", "left", { size: 130, knob: 56 });
    const stickR = makeStick("stick-right", "right", { size: 100, knob: 44, label: "look" });
    document.body.append(stickL.el, stickR.el);

    const isTouch = () => matchMedia("(hover: none) and (pointer: coarse)").matches;
    const isInGame = () => !!window.IRONYARD_INGAME;
    const updateLayout = () => {
      const showSticks = isTouch() && isInGame();
      stickL.el.style.display = showSticks ? "block" : "none";
      stickR.el.style.display = showSticks ? "block" : "none";
      this.touchActive = isTouch();
    };
    updateLayout();
    setInterval(updateLayout, 250);
    window.addEventListener("resize", updateLayout);

    const findActiveStick = (touches) => {
      const out = [];
      for (const stk of [stickL, stickR]) {
        if (stk.tid == null) continue;
        for (const t of touches) if (t.identifier === stk.tid) { out.push({ stick: stk, t }); break; }
      }
      return out;
    };

    const isTouchTargetUI = (target) => {
      let n = target;
      while (n && n !== document.body) {
        const id = n.id || "";
        if (id === "menu" || id === "settings" || id === "settings-btn" ||
            id === "touch-buttons" || id === "attack-pad") return true;
        if (n.tagName === "BUTTON" || n.tagName === "INPUT" || n.tagName === "LABEL") return true;
        n = n.parentNode;
      }
      return false;
    };

    document.addEventListener("touchstart", (e) => {
      if (!isInGame()) return;
      if (isTouchTargetUI(e.target)) return;
      for (const t of e.changedTouches) {
        const halfX = window.innerWidth / 2;
        // Left half → movement stick. Right half → camera stick (only the LOWER 60%
        // of the right half so attack pad above isn't claimed by stick logic).
        if (t.clientX < halfX && stickL.tid == null) {
          stickL.start(t.clientX, t.clientY, t.identifier);
        } else if (t.clientX >= halfX && stickR.tid == null) {
          stickR.start(t.clientX, t.clientY, t.identifier);
        }
      }
      e.preventDefault();
    }, { passive: false });

    document.addEventListener("touchmove", (e) => {
      if (!isInGame()) return;
      const active = findActiveStick(e.changedTouches);
      for (const a of active) a.stick.move(a.t.clientX, a.t.clientY);
      if (active.length) e.preventDefault();
    }, { passive: false });

    const onEnd = (e) => {
      for (const t of e.changedTouches) {
        if (stickL.tid === t.identifier) stickL.end();
        if (stickR.tid === t.identifier) stickR.end();
      }
    };
    document.addEventListener("touchend",    onEnd, { passive: false });
    document.addEventListener("touchcancel", onEnd, { passive: false });

    this._stickL = stickL;
    this._stickR = stickR;

    // Action buttons (jump/sprint/block) — top of right side, compact.
    const buttonRow = document.createElement("div");
    buttonRow.id = "touch-buttons";
    Object.assign(buttonRow.style, {
      position: "fixed", right: "12px", top: "12px",
      display: "none", flexDirection: "row", gap: "8px",
      zIndex: 20, userSelect: "none",
    });
    document.body.append(buttonRow);
    const mkBtn = (label, prop, isToggle = false) => {
      const b = document.createElement("div");
      b.textContent = label;
      Object.assign(b.style, {
        width: "52px", height: "52px", borderRadius: "50%",
        background: "rgba(0,0,0,0.5)", border: "2px solid #c8a97e",
        color: "#f1d9b3", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "11px", touchAction: "none",
      });
      const setActive = (on) => {
        b.style.background = on ? "rgba(200,170,130,0.4)" : "rgba(0,0,0,0.5)";
      };
      if (isToggle) {
        b.addEventListener("touchstart", (e) => { this[prop] = !this[prop]; setActive(this[prop]); e.preventDefault(); }, { passive: false });
      } else {
        const press = (e) => { this[prop] = true;  setActive(true);  e.preventDefault(); };
        const release = (e) => { this[prop] = false; setActive(false); e.preventDefault(); };
        b.addEventListener("touchstart", press, { passive: false });
        b.addEventListener("touchend",   release, { passive: false });
        b.addEventListener("touchcancel",release, { passive: false });
      }
      return b;
    };
    const btnJump   = mkBtn("JUMP",  "jump");
    const btnBlock  = mkBtn("BLOCK", "block");
    const btnSprint = mkBtn("RUN",   "sprint");
    buttonRow.append(btnJump, btnSprint, btnBlock);

    // Attack pad — 2x2 grid in middle-right, above camera stick.
    const attackPad = document.createElement("div");
    attackPad.id = "attack-pad";
    Object.assign(attackPad.style, {
      position: "fixed", right: "12px", bottom: "140px",
      display: "none",
      gridTemplateColumns: "50px 50px",
      gridTemplateRows: "50px 50px",
      gap: "6px",
      zIndex: 16, userSelect: "none",
    });
    document.body.append(attackPad);
    const mkAtkBtn = (label, kind, color = "#c8a97e") => {
      const b = document.createElement("div");
      b.textContent = label;
      Object.assign(b.style, {
        width: "50px", height: "50px", borderRadius: "10px",
        background: "rgba(0,0,0,0.55)", border: `2px solid ${color}`,
        color: color, fontSize: "10px", letterSpacing: "0.04em",
        display: "flex", alignItems: "center", justifyContent: "center",
        textAlign: "center", touchAction: "none",
      });
      const fire = (e) => { this._attackQueued = kind; e.preventDefault(); };
      b.addEventListener("touchstart", fire, { passive: false });
      b.addEventListener("mousedown", fire);
      return b;
    };
    attackPad.append(
      mkAtkBtn("OVER", "overhead", "#ffd060"),
      mkAtkBtn("STAB", "stab",     "#a8e6ff"),
      mkAtkBtn("◄ SW", "swingL"),
      mkAtkBtn("SW ►", "swingR"),
    );

    const showAll = () => {
      const on = this.touchActive && isInGame();
      attackPad.style.display = on ? "grid" : "none";
      buttonRow.style.display = on ? "flex" : "none";
    };
    showAll();
    setInterval(showAll, 250);
    window.addEventListener("resize", showAll);
  }

  // Sample current state and reset edge-triggered things.
  sample(dt) {
    // Movement.
    if (this._stickL && this._stickL.tid != null) {
      this.mv.x = this._stickL.dx;
      this.mv.y = this._stickL.dy;
    } else {
      let mx = 0, my = 0;
      if (this._keys.has("KeyW") || this._keys.has("ArrowUp")) my -= 1;
      if (this._keys.has("KeyS") || this._keys.has("ArrowDown")) my += 1;
      if (this._keys.has("KeyA") || this._keys.has("ArrowLeft")) mx -= 1;
      if (this._keys.has("KeyD") || this._keys.has("ArrowRight")) mx += 1;
      const l = Math.hypot(mx, my);
      if (l > 1) { mx /= l; my /= l; }
      this.mv.x = mx; this.mv.y = my;
    }

    if (!this.touchActive) {
      this.sprint = this._keys.has("ShiftLeft") || this._keys.has("ShiftRight");
      // Block: F or RMB held.
      this.block  = this._keys.has("KeyF") || this._rmbDown;
    }

    // Right stick → camera deltas.
    if (this._stickR && this._stickR.tid != null) {
      const dx = this._stickR.dx, dy = this._stickR.dy;
      this.cameraYawDelta   += dx * dt * 2.6;
      this.cameraPitchDelta += dy * dt * 1.6;
    }

    const attackTrigger = this._attackQueued;
    this._attackQueued = null;

    const out = {
      mv: { ...this.mv },
      sprint: this.sprint,
      jump: this.jump,
      block: this.block,
      zoomDelta: this.zoomDelta,
      cameraYawDelta: this.cameraYawDelta,
      cameraPitchDelta: this.cameraPitchDelta,
      attackTrigger,
    };
    this.cameraYawDelta = 0;
    this.cameraPitchDelta = 0;
    this.jump = false;
    this.zoomDelta = 0;
    return out;
  }
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function makeStick(id, side, opts = {}) {
  const size = opts.size ?? 150;
  const knobSize = opts.knob ?? 60;
  const label = opts.label ?? (side === "left" ? "move" : "look");
  const el = document.createElement("div");
  el.id = id;
  Object.assign(el.style, {
    position: "fixed", bottom: "16px",
    [side]: "16px",
    width: size + "px", height: size + "px",
    borderRadius: "50%",
    background: "rgba(0,0,0,0.32)",
    border: "2px solid rgba(200,170,130,0.55)",
    touchAction: "none", zIndex: 15, display: "none",
  });
  const knob = document.createElement("div");
  Object.assign(knob.style, {
    position: "absolute", left: "50%", top: "50%",
    width: knobSize + "px", height: knobSize + "px",
    marginLeft: -(knobSize / 2) + "px", marginTop: -(knobSize / 2) + "px",
    borderRadius: "50%", background: "rgba(200,170,130,0.55)",
    boxShadow: "0 0 10px rgba(200,170,130,0.65)",
  });
  el.append(knob);
  const labelEl = document.createElement("div");
  Object.assign(labelEl.style, {
    position: "absolute", left: "50%", top: "-18px", transform: "translateX(-50%)",
    color: "#c8a97e", fontSize: "10px", letterSpacing: "0.1em", textTransform: "uppercase",
  });
  labelEl.textContent = label;
  el.append(labelEl);

  const r = (size - knobSize) / 2;
  const stick = {
    el, knob, side, tid: null, ox: 0, oy: 0, dx: 0, dy: 0,
    start(x, y, id) {
      this.tid = id; this.ox = x; this.oy = y; this.dx = 0; this.dy = 0; this.update(0, 0);
    },
    move(x, y) {
      let dx = (x - this.ox) / r, dy = (y - this.oy) / r;
      const m = Math.hypot(dx, dy);
      if (m > 1) { dx /= m; dy /= m; }
      this.dx = dx; this.dy = dy; this.update(dx * r, dy * r);
    },
    end() { this.tid = null; this.dx = 0; this.dy = 0; this.update(0, 0); },
    update(px, py) { knob.style.transform = `translate(${px}px, ${py}px)`; },
  };
  return stick;
}
