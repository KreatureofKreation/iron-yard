// Unified input source. Desktop: keyboard + mouse. Mobile: touch joysticks.
// Output state: { mv:{x,y}, aim:{x,y}, sprint, jump, block }
//   mv: -1..1, world-relative movement direction (camera-relative computed elsewhere).
//   aim: -1..1, the "right stick" — sword tip target relative to player facing arc.
//
// Aim coords:
//   aim.x: lateral (-1 left, 1 right)
//   aim.y: vertical/forward extension (-1 below/back, 1 up/forward)
//   magnitude: how far/extended sword reaches (0 rest, 1 full extension).

import { CLIENT } from "./config.js";

export class Input {
  constructor() {
    this.mv = { x: 0, y: 0 };
    this.aim = { x: 0, y: 0 };
    this.aimSmoothed = { x: 0, y: 0 };
    this.sprint = false;
    this.jump = false;          // edge: consumed each tick
    this.block = false;
    this.cameraYawDelta = 0;    // mouse drag of right side (mobile) or wheel (desktop)
    this.cameraPitchDelta = 0;
    this.zoomDelta = 0;
    this.touchActive = false;

    this._keys = new Set();
    this._mouse = { down: false, pressed: false };
    this._mousePos = { x: 0.5, y: 0.5 };  // normalized 0..1 on canvas

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
    window.addEventListener("keyup", (e) => { this._keys.delete(e.code); });
    window.addEventListener("blur", () => this._keys.clear());
  }

  _installMouse() {
    window.addEventListener("mousemove", (e) => {
      const w = window.innerWidth, h = window.innerHeight;
      this._mousePos.x = e.clientX / w;
      this._mousePos.y = e.clientY / h;
    });
    window.addEventListener("mousedown", (e) => {
      if (e.button === 0) this._mouse.down = true;
      if (e.button === 1 || e.button === 2) {
        this._cameraDragging = true;
        this._lastCamX = e.clientX; this._lastCamY = e.clientY;
        e.preventDefault();
      }
    });
    window.addEventListener("mouseup",   (e) => {
      if (e.button === 0) this._mouse.down = false;
      if (e.button === 1 || e.button === 2) this._cameraDragging = false;
    });
    window.addEventListener("mousemove", (e) => {
      if (this._cameraDragging) {
        const dx = e.clientX - this._lastCamX;
        const dy = e.clientY - this._lastCamY;
        this._lastCamX = e.clientX; this._lastCamY = e.clientY;
        this.cameraYawDelta += dx * 0.005;
        this.cameraPitchDelta += dy * 0.003;
      }
    });
    window.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("wheel", (e) => {
      this.zoomDelta += Math.sign(e.deltaY) * 0.4;
    }, { passive: true });
  }

  _installTouch() {
    // Two-zone twin-stick. Left half = move stick. Right half = aim stick.
    // We attach to the document so any touch on the game canvas works.
    const stickL = makeStick("stick-left", "left");
    const stickR = makeStick("stick-right", "right");
    document.body.append(stickL.el, stickR.el);

    const updateLayout = () => {
      // Show stick UI on touch devices only.
      const touch = matchMedia("(hover: none) and (pointer: coarse)").matches;
      stickL.el.style.display = touch ? "block" : "none";
      stickR.el.style.display = touch ? "block" : "none";
      this.touchActive = touch;
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);

    const handleStart = (zone, e) => {
      const t = e.changedTouches[0];
      const stick = zone === "left" ? stickL : stickR;
      stick.start(t.clientX, t.clientY, t.identifier);
      e.preventDefault();
    };

    const findActive = (zone, touches) => {
      const stick = zone === "left" ? stickL : stickR;
      if (stick.tid == null) return null;
      for (const t of touches) if (t.identifier === stick.tid) return { stick, t };
      return null;
    };

    document.addEventListener("touchstart", (e) => {
      for (const t of e.changedTouches) {
        const halfX = window.innerWidth / 2;
        if (t.clientX < halfX && stickL.tid == null) {
          stickL.start(t.clientX, t.clientY, t.identifier);
        } else if (t.clientX >= halfX && stickR.tid == null) {
          stickR.start(t.clientX, t.clientY, t.identifier);
        }
      }
      e.preventDefault();
    }, { passive: false });

    document.addEventListener("touchmove", (e) => {
      for (const stick of [stickL, stickR]) {
        const a = findActive(stick === stickL ? "left" : "right", e.changedTouches);
        if (a) a.stick.move(a.t.clientX, a.t.clientY);
      }
      e.preventDefault();
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

    // Touch buttons: jump, sprint, block.
    const buttonRow = document.createElement("div");
    buttonRow.id = "touch-buttons";
    Object.assign(buttonRow.style, {
      position: "fixed", left: "50%", bottom: "30px",
      transform: "translateX(-50%)",
      display: "none", flexDirection: "row", gap: "12px",
      zIndex: 20, userSelect: "none",
    });
    document.body.append(buttonRow);
    const mkBtn = (label, prop, isToggle = false) => {
      const b = document.createElement("div");
      b.textContent = label;
      Object.assign(b.style, {
        width: "62px", height: "62px", borderRadius: "50%",
        background: "rgba(0,0,0,0.5)", border: "2px solid #c8a97e",
        color: "#f1d9b3", display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: "13px", touchAction: "none",
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
    const btnRotL   = mkBtn("◄", "_camRotL");
    const btnJump   = mkBtn("JUMP",  "jump");
    const btnBlock  = mkBtn("BLOCK", "block");
    const btnSprint = mkBtn("RUN",   "sprint");
    const btnRotR   = mkBtn("►", "_camRotR");
    buttonRow.append(btnRotL, btnJump, btnBlock, btnSprint, btnRotR);

    const showButtons = () => {
      buttonRow.style.display = this.touchActive ? "flex" : "none";
    };
    showButtons();
    window.addEventListener("resize", showButtons);
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

    // Aim — this drives sword direction.
    if (this._stickR && this._stickR.tid != null) {
      // Right stick: dx = lateral, dy = forward (-1 = up/forward, 1 = back/down).
      // Map to aim coords: x=dx, y=-dy (so up on stick = forward/up).
      this.aim.x = this._stickR.dx;
      this.aim.y = -this._stickR.dy;
    } else if (this.touchActive) {
      // Idle on mobile when no touch — sword rests.
      this.aim.x *= 0.85;
      this.aim.y *= 0.85;
    } else {
      // Desktop: mouse position drives aim. Map screen → -1..1, scaled by user sensitivity.
      const sens = ((window.IRONYARD_SETTINGS && window.IRONYARD_SETTINGS.sens) || 100) / 100;
      const ax = (this._mousePos.x - 0.5) * 2 * sens;
      const ay = (0.5 - this._mousePos.y) * 2 * sens;
      this.aim.x = Math.max(-1.4, Math.min(1.4, ax));
      this.aim.y = Math.max(-1.4, Math.min(1.4, ay));
    }

    // Smoothing for sword position; raw vel still gives swing speed via tip motion.
    const k = Math.min(1, dt * 18);
    this.aimSmoothed.x += (this.aim.x - this.aimSmoothed.x) * k;
    this.aimSmoothed.y += (this.aim.y - this.aimSmoothed.y) * k;

    if (!this.touchActive) {
      this.sprint = this._keys.has("ShiftLeft") || this._keys.has("ShiftRight");
      this.block  = this._keys.has("KeyF");
    }

    // Camera-rotate touch buttons emit deltas while held.
    if (this._camRotL) this.cameraYawDelta -= dt * 2.2;
    if (this._camRotR) this.cameraYawDelta += dt * 2.2;
    const out = {
      mv: { ...this.mv },
      aim: { ...this.aim },
      aimSmoothed: { ...this.aimSmoothed },
      sprint: this.sprint,
      jump: this.jump,
      block: this.block,
      zoomDelta: this.zoomDelta,
      cameraYawDelta: this.cameraYawDelta,
      cameraPitchDelta: this.cameraPitchDelta,
    };
    this.cameraYawDelta = 0;
    this.cameraPitchDelta = 0;
    this.jump = false;            // edge consumed
    this.zoomDelta = 0;
    return out;
  }
}

function makeStick(id, side) {
  const el = document.createElement("div");
  el.id = id;
  Object.assign(el.style, {
    position: "fixed", bottom: "20px",
    [side]: "20px",
    width: "150px", height: "150px",
    borderRadius: "50%",
    background: "rgba(0,0,0,0.35)",
    border: "2px solid rgba(200,170,130,0.6)",
    touchAction: "none", zIndex: 15, display: "none",
  });
  const knob = document.createElement("div");
  Object.assign(knob.style, {
    position: "absolute", left: "50%", top: "50%",
    width: "60px", height: "60px", marginLeft: "-30px", marginTop: "-30px",
    borderRadius: "50%", background: "rgba(200,170,130,0.6)",
    boxShadow: "0 0 12px rgba(200,170,130,0.7)",
  });
  el.append(knob);
  const label = document.createElement("div");
  Object.assign(label.style, {
    position: "absolute", left: "50%", top: "-22px", transform: "translateX(-50%)",
    color: "#c8a97e", fontSize: "11px", letterSpacing: "0.1em", textTransform: "uppercase",
  });
  label.textContent = side === "left" ? "move" : "sword";
  el.append(label);

  const stick = {
    el, knob, side, tid: null, ox: 0, oy: 0, dx: 0, dy: 0,
    start(x, y, id) {
      this.tid = id; this.ox = x; this.oy = y; this.dx = 0; this.dy = 0; this.update(0, 0);
    },
    move(x, y) {
      const r = 60;
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
