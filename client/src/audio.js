// Procedural Web Audio. No asset files. Lazy-init on first user gesture.
let ctx = null;
let master = null;
let unlocked = false;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);
  return ctx;
}

// Build a stereo panner that feeds master, returning the panner as the new sink node.
// Pan range is -1 (left) .. 1 (right). Falls back to master if StereoPanner not available.
function panned(pan = 0) {
  if (!ctx) return null;
  if (typeof ctx.createStereoPanner !== "function") return master;
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  p.connect(master);
  return p;
}

export function unlockAudio() {
  ensureCtx();
  if (!ctx || unlocked) return;
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  unlocked = true;
}

export function setMasterVolume(v) {
  ensureCtx();
  if (master) master.gain.value = Math.max(0, Math.min(1, v));
}

function envGain(t0, attack, decay, peak = 1) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  return g;
}

function noiseBuffer(durMs) {
  const len = Math.max(64, Math.floor(ctx.sampleRate * (durMs / 1000)));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1);
  return buf;
}

// Air whoosh — band-passed noise sweep. speed 0..1.
export function whoosh(speed = 0.5, pan = 0) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = panned(pan);
  const t0 = ctx.currentTime;
  const dur = 0.12 + speed * 0.18;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(dur * 1100);
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.setValueAtTime(400 + speed * 600, t0);
  bp.frequency.exponentialRampToValueAtTime(1200 + speed * 1800, t0 + dur);
  bp.Q.value = 1.4;
  const env = envGain(t0, 0.01, dur, 0.18 + speed * 0.45);
  src.connect(bp).connect(env).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

// Metallic-ish hit. severity 0..1 → amplitude + lower mid emphasis.
export function hit(severity = 0.5, pan = 0) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = panned(pan);
  const t0 = ctx.currentTime;

  const osc = ctx.createOscillator();
  osc.type = "triangle";
  osc.frequency.setValueAtTime(140 + severity * 80, t0);
  osc.frequency.exponentialRampToValueAtTime(60, t0 + 0.16);
  const oscEnv = envGain(t0, 0.005, 0.18, 0.7 * (0.4 + severity * 0.7));
  osc.connect(oscEnv).connect(out);
  osc.start(t0); osc.stop(t0 + 0.22);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(150);
  const hp = ctx.createBiquadFilter();
  hp.type = "highpass"; hp.frequency.value = 1200;
  const noiseEnv = envGain(t0, 0.003, 0.10, 0.5 * (0.3 + severity * 0.7));
  noise.connect(hp).connect(noiseEnv).connect(out);
  noise.start(t0); noise.stop(t0 + 0.12);

  if (severity > 0.4) {
    const ring = ctx.createOscillator();
    ring.type = "square";
    ring.frequency.setValueAtTime(1300 + severity * 600, t0);
    const ringEnv = envGain(t0, 0.002, 0.18, 0.05 + severity * 0.07);
    ring.connect(ringEnv).connect(out);
    ring.start(t0); ring.stop(t0 + 0.22);
  }
}

// Two blades clashing.
export function clash(pan = 0) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = panned(pan);
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "square";
  o.frequency.setValueAtTime(1700, t0);
  o.frequency.exponentialRampToValueAtTime(800, t0 + 0.25);
  const e = envGain(t0, 0.002, 0.30, 0.18);
  o.connect(e).connect(out);
  o.start(t0); o.stop(t0 + 0.32);

  const o2 = ctx.createOscillator();
  o2.type = "sawtooth";
  o2.frequency.setValueAtTime(2400, t0);
  const e2 = envGain(t0, 0.001, 0.18, 0.10);
  o2.connect(e2).connect(out);
  o2.start(t0); o2.stop(t0 + 0.22);
}

// Helm ricochet — bright metallic ping sweep, distinct from clash.
export function ricochet(pan = 0) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = panned(pan);
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "triangle";
  o.frequency.setValueAtTime(2400, t0);
  o.frequency.exponentialRampToValueAtTime(900, t0 + 0.40);
  const e = envGain(t0, 0.001, 0.42, 0.30);
  o.connect(e).connect(out);
  o.start(t0); o.stop(t0 + 0.45);

  const o2 = ctx.createOscillator();
  o2.type = "sine";
  o2.frequency.setValueAtTime(3200, t0);
  o2.frequency.exponentialRampToValueAtTime(1200, t0 + 0.30);
  const e2 = envGain(t0, 0.001, 0.30, 0.18);
  o2.connect(e2).connect(out);
  o2.start(t0); o2.stop(t0 + 0.32);
}

// Death — low rumble + falling tone.
export function death(pan = 0) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = panned(pan);
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(220, t0);
  o.frequency.exponentialRampToValueAtTime(45, t0 + 0.7);
  const e = envGain(t0, 0.01, 0.7, 0.45);
  o.connect(e).connect(out);
  o.start(t0); o.stop(t0 + 0.8);
}

// Hurt grunt — low-mid noise burst.
export function hurt(pan = 0) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = panned(pan);
  const t0 = ctx.currentTime;
  const n = ctx.createBufferSource();
  n.buffer = noiseBuffer(200);
  const f = ctx.createBiquadFilter();
  f.type = "lowpass"; f.frequency.value = 700;
  const e = envGain(t0, 0.005, 0.20, 0.30);
  n.connect(f).connect(e).connect(out);
  n.start(t0); n.stop(t0 + 0.22);
}

// Footstep — short low thud. pan defaults to 0 (own footsteps); remotes pass a pan value.
let lastStepAt = 0;
export function footstep(pan = 0, dampen = 1) {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const now = performance.now();
  if (now - lastStepAt < 60) return;
  lastStepAt = now;
  const out = pan ? panned(pan) : master;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "sine";
  o.frequency.setValueAtTime(140, t0);
  o.frequency.exponentialRampToValueAtTime(60, t0 + 0.10);
  const e = envGain(t0, 0.005, 0.10, (0.18 + Math.random() * 0.06) * dampen);
  o.connect(e).connect(out);
  o.start(t0); o.stop(t0 + 0.13);
}

// UI click.
export function click() {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = master;
  const t0 = ctx.currentTime;
  const o = ctx.createOscillator();
  o.type = "square";
  o.frequency.value = 880;
  const e = envGain(t0, 0.001, 0.05, 0.12);
  o.connect(e).connect(out);
  o.start(t0); o.stop(t0 + 0.07);
}

// Victory fanfare — short heroic two-tone.
export function fanfare() {
  if (!unlocked) return;
  ensureCtx(); if (!ctx) return;
  const out = master;
  const t0 = ctx.currentTime;
  const notes = [[330, 0], [495, 0.22], [660, 0.42]];
  for (const [hz, off] of notes) {
    const o = ctx.createOscillator();
    o.type = "triangle";
    o.frequency.setValueAtTime(hz, t0 + off);
    const g = envGain(t0 + off, 0.01, 0.32, 0.18);
    o.connect(g).connect(out);
    o.start(t0 + off); o.stop(t0 + off + 0.45);
  }
}
