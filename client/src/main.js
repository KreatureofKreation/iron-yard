import * as THREE from "three";
import { CLIENT, RUNTIME, applyRuntime } from "./config.js";
import { Net } from "./network.js";
import { Input } from "./input.js";
import { buildScene } from "./scene.js";
import { buildCharacter, WEAPON_LIST } from "./character.js";
import { HUD } from "./hud.js";
import * as SFX from "./audio.js";
import { initRapier, rapierStep, createRagdoll, tickRagdolls, clearAllRagdolls,
         spawnArenaProps, applyKickToProps, syncProps, clearArenaProps,
         spawnFallingHelm } from "./ragdoll.js";

// ---------- Renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.getElementById("app").append(renderer.domElement);

let { scene } = buildScene();

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 5, 8);
camera.lookAt(0, 1, 0);

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---------- State ----------
const net = new Net();
const input = new Input();

const state = {
  myId: null,
  // map: id -> { rig, snapBuffer:[{ts,pos,yaw,weaponTip,...}], visual:{pos,yaw}, hp, alive, name, score, deaths }
  remotes: new Map(),
  // local predicted player
  local: {
    pos: new THREE.Vector3(0, 0, 0),
    yaw: 0,
    vel: new THREE.Vector3(),
    onGround: true,
    hp: RUNTIME.player.hp,
    alive: true,
  },
  rig: null,                      // local rig
  // Fixed-orientation camera by default. Rotates only when user explicitly drags
  // (middle-mouse on desktop, ◄ ► buttons on mobile, Q/E keys). No auto-follow loop.
  cameraYaw: 0,
  footstepPhase: 0,
  cameraPitch: 0.45,
  cameraDist: 4.2,
  cameraDragging: false,
  spectatorTargetId: null,
  spectatorOrbitT: 0,
  match: { phase: "playing", round: 1, phaseMsLeft: 0, roundMsLeft: 0, scoreToWin: 5, winnerId: null, winReason: null },
  weaponTipWorld: new THREE.Vector3(),
  weaponTipTarget: new THREE.Vector3(),
  weaponTipPrev: new THREE.Vector3(),
  weaponTipVel: new THREE.Vector3(),
  lastInputSentAt: 0,
  inputSeq: 0,
  serverConfigReceived: false,
  weaponKey: "arming",
  shake: { mag: 0, t: 0, decay: 4 },
  swingPlayedAt: 0,
  attack: null,                 // { type, start, duration } when an attack is playing
};

// ---------- Color palette per id ----------
const PALETTE = [
  { color: 0x6b8a9a, accent: 0xc8a97e },  // blue-gray
  { color: 0x8a6b5a, accent: 0xe2c08a },  // umber
  { color: 0x6a7a4a, accent: 0xc8a97e },  // moss
  { color: 0x7a5a7a, accent: 0xd1a05a },  // mauve
];
function paletteFor(id, customColor = 0) {
  const base = PALETTE[(id - 1) % PALETTE.length];
  if (customColor) return { color: customColor, accent: base.accent };
  return base;
}

// Match defaults; updated when welcome arrives.
let CLIENT_MATCH_INTERMISSION_MS = 6000;

// Persistent career stats in localStorage.
function statsLoad() {
  try { return JSON.parse(localStorage.getItem("ironyard.stats") || "{}"); }
  catch { return {}; }
}
function statsSave(s) { try { localStorage.setItem("ironyard.stats", JSON.stringify(s)); } catch {} }
function statsBump(key, delta = 1) {
  const s = statsLoad();
  s[key] = (s[key] || 0) + delta;
  statsSave(s);
}
function statsHtml() {
  const s = statsLoad();
  const k = s.kills || 0, d = s.deaths || 0, w = s.wins || 0, l = s.losses || 0;
  return `K ${k} · D ${d} · W ${w} · L ${l}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}

// ---------- Helpers ----------
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

function shoulderWorld(pos, yaw, out = new THREE.Vector3()) {
  const sx = 0.30 * Math.cos(yaw);
  const sz = -0.30 * Math.sin(yaw);
  return out.set(pos.x + sx, pos.y + 1.4, pos.z + sz);
}

// Discrete button-driven attacks based on historical longsword stances:
//   rest     = Vom Tag           (sword on right shoulder, tip up + slightly back)
//   stab     = Pflug → Langort   (mid-low wind, thrust forward to face/chest)
//   overhead = Oberhau           (high wind from Vom Tag, strike down through center)
//   swingR/L = Mittelhau         (cross-body horizontal cut at chest height)
// Player-local coords: x=right, y=up, z=forward. The actual sword body is driven by
// the server's spring toward these targets, so heavier weapons still feel heavy.
//
// Rest pose varies by weapon style. Each entry is the player-local tip position.
// Relaxed carry positions — sword hangs at side angled forward, not held in a
// combat-ready guard. Combat-ready Vom Tag was the prior default but read as
// "stuck up high" during idle. Attack windups animate UP TO the guard then strike.
//   sword (one/two-hand): tip down-forward at right side (Coda Lunga / relaxed carry)
//   sword+shield:         tip down-forward, slightly tighter to body
//   spear:                Mittel/Vor — tip forward at chest level (spear's natural ready)
const REST_BY_KEY = {
  "two-hand":  { x: 0.45, y: 1.00, z:  0.55 },
  "one-hand":  { x: 0.45, y: 1.00, z:  0.55 },
  "shield":    { x: 0.45, y: 1.10, z:  0.40 },
  "spear":     { x: 0.20, y: 1.55, z:  1.40 },
  "mace":      { x: 0.45, y: 1.05, z:  0.40 },
};
const REST_LOCAL_BASE = REST_BY_KEY["one-hand"];

function restBaseFor(weaponKey, grip) {
  if (weaponKey === "spear") return REST_BY_KEY.spear;
  if (weaponKey === "mace")  return REST_BY_KEY.mace;
  return REST_BY_KEY[grip] || REST_BY_KEY["one-hand"];
}

// Idle / breathing sway for the rest pose so the sword never feels glued in place.
// mvSpeed bumps stride amplitude.
function restLocal(now, mvSpeed = 0, weaponKey = "arming", grip = "one-hand") {
  const base = restBaseFor(weaponKey, grip);
  const t = now / 1000;
  const breath = Math.sin(t * 1.3) * 0.04;
  const sway   = Math.sin(t * 0.85 + 0.7) * 0.05;
  const walk   = Math.min(1, mvSpeed / 4);
  const bob    = Math.sin(t * (4 + mvSpeed * 1.2)) * 0.08 * walk;
  const stride = Math.sin(t * (2 + mvSpeed * 0.6)) * 0.06 * walk;
  return {
    x: base.x + sway + stride,
    y: base.y + breath + bob,
    z: base.z + Math.cos(t * 0.85 + 0.7) * 0.06 + stride * 0.4,
  };
}

const REST = REST_LOCAL_BASE;
// Spear paths — HEMA polearm style. Tip default forward (Mittel/Vor). Stab is primary;
// swings are wide shaft sweeps; overhead is a high-Ober chop. Reach extends to spear length.
const SPEAR_REST = REST_BY_KEY.spear;
const SPEAR_PATHS = {
  stab: {
    duration: 340,
    wpts: [
      { t: 0.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
      { t: 0.20, x: 0.20,         y: 1.55,         z: 0.10 },                  // coil back tight
      { t: 0.50, x: 0.20,         y: 1.55,         z: 2.70 },                  // full Langort reach
      { t: 0.80, x: 0.20,         y: 1.50,         z: 0.50 },
      { t: 1.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
    ],
  },
  overhead: {
    duration: 580,
    wpts: [
      { t: 0.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
      { t: 0.22, x: 0.50,         y: 2.65,         z: -0.40 },                  // raise high
      { t: 0.55, x: 0.20,         y: 1.10,         z: 1.95 },                   // chop down + far forward
      { t: 0.82, x: 0.20,         y: 0.85,         z: 0.80 },
      { t: 1.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
    ],
  },
  swingR: {
    duration: 500,
    wpts: [
      { t: 0.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
      { t: 0.22, x: -1.10,        y: 1.55,         z:  0.50 },                  // wind hard left
      { t: 0.55, x:  0.10,        y: 1.50,         z:  2.30 },                  // sweep extended
      { t: 0.80, x:  1.40,        y: 1.10,         z:  0.50 },                  // far right follow-through
      { t: 1.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
    ],
  },
  swingL: {
    duration: 500,
    wpts: [
      { t: 0.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
      { t: 0.22, x:  1.10,        y: 1.55,         z:  0.50 },
      { t: 0.55, x: -0.10,        y: 1.50,         z:  2.30 },
      { t: 0.80, x: -1.40,        y: 1.10,         z:  0.50 },
      { t: 1.00, x: SPEAR_REST.x, y: SPEAR_REST.y, z: SPEAR_REST.z },
    ],
  },
};

// Mace — heavy committed strikes per ARMA discussion. Primary is sideways horizontal
// blow (prevents slipping). Overhead is the natural finisher. Stab is a weak forward
// jab with the head (the mace has no point — included for completeness/utility).
const MACE_REST = REST_BY_KEY.mace;
const MACE_PATHS = {
  // Heavy committed sideways blows. Bigger arcs than sword — momentum-driven.
  swingR: {
    duration: 540,
    wpts: [
      { t: 0.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
      { t: 0.22, x: -1.00,       y: 1.80,        z: -0.20 },                       // wind way back over left shoulder
      { t: 0.52, x:  0.15,       y: 1.45,        z:  1.40 },                       // heavy strike apex
      { t: 0.80, x:  1.20,       y: 0.75,        z:  0.20 },                       // crashes through to right hip
      { t: 1.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
    ],
  },
  swingL: {
    duration: 540,
    wpts: [
      { t: 0.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
      { t: 0.22, x:  1.00,       y: 1.80,        z: -0.20 },
      { t: 0.52, x: -0.15,       y: 1.45,        z:  1.40 },
      { t: 0.80, x: -1.20,       y: 0.75,        z:  0.20 },
      { t: 1.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
    ],
  },
  // Skull-crusher overhead — load way up, drop it through center.
  overhead: {
    duration: 640,
    wpts: [
      { t: 0.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
      { t: 0.25, x:  0.55,       y: 2.70,        z: -0.50 },                       // sky-high wind
      { t: 0.55, x:  0.15,       y: 1.10,        z:  1.30 },                       // smash apex
      { t: 0.85, x: -0.20,       y: 0.10,        z:  0.95 },                       // ground follow-through
      { t: 1.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
    ],
  },
  stab: {
    duration: 400,
    wpts: [
      { t: 0.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
      { t: 0.25, x: 0.30,        y: 1.40,        z: -0.05 },
      { t: 0.55, x: 0.30,        y: 1.40,        z:  1.30 },
      { t: 0.80, x: 0.30,        y: 1.45,        z:  0.20 },
      { t: 1.00, x: MACE_REST.x, y: MACE_REST.y, z: MACE_REST.z },
    ],
  },
};

function pathsFor(weaponKey) {
  if (weaponKey === "spear") return SPEAR_PATHS;
  if (weaponKey === "mace")  return MACE_PATHS;
  return ATTACK_PATHS;
}
const ATTACK_PATHS = {
  // Mittelhau cross-cut left → right. Extreme wind across body, full extension forward,
  // sweeping follow-through past hip. Bigger arcs read as committed swings.
  swingR: {
    duration: 460,
    wpts: [
      { t: 0.00, x: REST.x,        y: REST.y,        z: REST.z },
      { t: 0.20, x: -0.95,         y: 1.65,          z: -0.30 },         // wind: deep left over shoulder
      { t: 0.48, x:  0.20,         y: 1.55,          z:  1.70 },         // strike apex extended forward
      { t: 0.72, x:  1.15,         y: 0.85,          z:  0.30 },         // follow-through past right hip
      { t: 1.00, x: REST.x,        y: REST.y,        z: REST.z },
    ],
  },
  swingL: {
    duration: 460,
    wpts: [
      { t: 0.00, x: REST.x,        y: REST.y,        z: REST.z },
      { t: 0.20, x:  0.95,         y: 1.65,          z: -0.30 },
      { t: 0.48, x: -0.20,         y: 1.55,          z:  1.70 },
      { t: 0.72, x: -1.15,         y: 0.85,          z:  0.30 },
      { t: 1.00, x: REST.x,        y: REST.y,        z: REST.z },
    ],
  },
  // Oberhau — load above the head, drive through chest to ankle on the far side.
  overhead: {
    duration: 560,
    wpts: [
      { t: 0.00, x: REST.x,        y: REST.y,        z: REST.z },
      { t: 0.22, x:  0.55,         y: 2.65,          z: -0.45 },         // wind high + back
      { t: 0.50, x:  0.15,         y: 1.30,          z:  1.55 },         // strike apex forward at chest
      { t: 0.78, x: -0.30,         y: 0.20,          z:  1.10 },         // chop through to opposite ankle
      { t: 1.00, x: REST.x,        y: REST.y,        z: REST.z },
    ],
  },
  // Stab — coil back hard, drive forward with full body extension.
  stab: {
    duration: 380,
    wpts: [
      { t: 0.00, x: REST.x,        y: REST.y,        z: REST.z },
      { t: 0.22, x:  0.10,         y: 1.10,          z:  0.05 },         // pull back tight to body
      { t: 0.50, x:  0.30,         y: 1.55,          z:  2.20 },         // thrust extended
      { t: 0.78, x:  0.20,         y: 1.20,          z:  0.30 },
      { t: 1.00, x: REST.x,        y: REST.y,        z: REST.z },
    ],
  },
};

function attackPathLocal(type, t, weaponKey = "arming") {
  const paths = pathsFor(weaponKey);
  const path = paths[type] ?? ATTACK_PATHS[type];
  if (!path) return REST_LOCAL_BASE;
  const w = path.wpts;
  for (let i = 0; i < w.length - 1; i++) {
    if (t <= w[i + 1].t) {
      const a = w[i], b = w[i + 1];
      const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return {
        x: a.x + (b.x - a.x) * u,
        y: a.y + (b.y - a.y) * u,
        z: a.z + (b.z - a.z) * u,
      };
    }
  }
  return w[w.length - 1];
}

// Convert a player-local point to world space using yaw.
function localToWorld(pos, yaw, local, out = new THREE.Vector3()) {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx =  Math.cos(yaw), rz = -Math.sin(yaw);
  out.set(
    pos.x + rx * local.x + fx * local.z,
    pos.y + local.y,
    pos.z + rz * local.x + fz * local.z,
  );
  return out;
}

// Resolve the current weapon-tip target this frame from attack state (or breathing rest).
function computeAttackTipTarget(state, pos, yaw, mvSpeed, weaponKey, grip, out) {
  const now = performance.now();
  let local = restLocal(now, mvSpeed, weaponKey, grip);
  if (state.attack && state.attack.type) {
    const elapsed = now - state.attack.start;
    const t = elapsed / state.attack.duration;
    if (t >= 1) {
      state.attack = null;
    } else {
      local = attackPathLocal(state.attack.type, t, weaponKey);
    }
  }
  return localToWorld(pos, yaw, local, out);
}

// Pose the local rig's right arm so the sword visually goes from shoulder to tip.
function poseRig(rig, posWorld, yaw, tipWorld) {
  rig.root.position.copy(posWorld);
  rig.root.rotation.y = yaw;

  // Direction from shoulder to tip in WORLD space.
  shoulderWorld(posWorld, yaw, tmpV);                // shoulder world
  tmpV2.subVectors(tipWorld, tmpV);                  // shoulder→tip world
  // Convert to character local space (only yaw rotation around Y).
  // localDir = inverse-yaw applied to world dir.
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw);
  const lx = cy * tmpV2.x + sy * tmpV2.z;
  const ly = tmpV2.y;
  const lz = -sy * tmpV2.x + cy * tmpV2.z;
  // Sword length is approximately RUNTIME.weapon.length; rig pose just needs orientation.
  // Aim the weaponRig so its local +Z axis (originally down) points along (lx,ly,lz).
  // Our rig hand is at -y in rig local; the sword's tip is along sword group's +Y after the -PI/2 X rotation.
  // We'll instead set the weaponRig's quaternion so its local "down" (negative Y) points along the desired dir,
  // because the arm + sword extend along -Y in the rig local frame.
  const desired = new THREE.Vector3(lx, ly, lz).normalize();
  const downAxis = new THREE.Vector3(0, -1, 0);
  rig.weaponRig.quaternion.setFromUnitVectors(downAxis, desired);
}

// ---------- Net handlers ----------
net.on("welcome", (m) => {
  applyRuntime(m);
  state.serverConfigReceived = true;
  state.myId = m.id;
  state.spectator = !!m.spectator;
  state.weaponKey = m.you?.weaponKey ?? state.weaponKey;
  if (m.you?.spawnPos) {
    state.cameraYaw = Math.atan2(m.you.spawnPos.x, m.you.spawnPos.z);
  }
  // Wipe any stale references to the old scene before rebuilding so we don't keep
  // writing to detached meshes / leak GPU memory.
  for (const m of serverPropMeshes) { try { scene.remove(m); } catch {} }
  serverPropMeshes.length = 0;
  for (const halo of swordHaloMap.values()) { try { scene.remove(halo); } catch {} }
  swordHaloMap.clear();
  clearAllRagdolls();
  scene = buildScene().scene;
  // Server-authoritative props: visual meshes built lazily as they appear in snap.
  // Spectators have no local rig; camera will pick a target each frame.
  if (!state.spectator) {
    const pal = paletteFor(m.id, state.colorPick);
    const grip = (RUNTIME.weapons[state.weaponKey]?.grip) || "one-hand";
    state.rig = buildCharacter({ ...pal, isLocal: true, weaponKey: state.weaponKey, grip });
    scene.add(state.rig.root);
    HUD.setHp(state.local.hp, RUNTIME.player.hp);
  } else {
    HUD.showBanner(`<div style="color:#9adfff;">SPECTATING</div>
      <div style="font-size:.75rem; opacity:.7; margin-top:.3rem;">arena full · slot opens when someone leaves</div>`, 5000);
    // Force the spectator camera path (reuses existing dead-player orbit logic).
    state.local.alive = false;
    state.local.pos.set(0, 0, 0);
  }
  for (const r of state.remotes.values()) scene.add(r.rig.root);
  HUD.setHp(state.local.hp, RUNTIME.player.hp);
  HUD.log(m.resumed ? "reconnected to your slot" : `welcome to the yard — ${state.weaponKey}`);
  // Controls onboarding (first time only).
  if (!localStorage.getItem("ironyard.onboarded")) {
    const isTouch = matchMedia("(hover: none) and (pointer: coarse)").matches;
    const ctrls = isTouch
      ? "left stick = move · right stick = sword<br>JUMP / RUN / BLOCK buttons · ◄ ► rotate camera<br>walk into ◯ rings to swap weapons"
      : "WASD = move · mouse = sword direction · F = block<br>shift = sprint · space = jump · click to lock cursor<br>ALT + mouse = rotate camera · scroll = zoom<br>walk into ◯ rings to swap weapons";
    HUD.showBanner(`<div style="font-size:1.0rem; line-height:1.5;">${ctrls}</div>
      <div style="font-size:.7rem; opacity:.5; margin-top:.6rem;">closing in 8s</div>`, 8000);
    localStorage.setItem("ironyard.onboarded", "1");
  }
});

net.on("snap", (m) => {
  // Update each player's snapshot buffer with timestamp.
  for (const p of m.players) {
    if (p.id === state.myId) {
      // Reconcile our pos: gentle correction.
      const dx = p.pos.x - state.local.pos.x;
      const dy = p.pos.y - state.local.pos.y;
      const dz = p.pos.z - state.local.pos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > 1.5) {
        state.local.pos.set(p.pos.x, p.pos.y, p.pos.z); // hard snap if very off
      } else {
        state.local.pos.x += dx * 0.25;
        state.local.pos.y += dy * 0.25;
        state.local.pos.z += dz * 0.25;
      }
      const wasAlive = state.local.alive;
      state.local.hp = p.hp;
      state.local.stamina = p.stamina;
      state.local.alive = p.alive;
      state.local.invulnMs = p.invulnMs || 0;
      state.local.crippleMsLeft = p.crippleMsLeft || 0;
      state.local.severedLeg = !!p.severedLeg;
      state.local.severedArm = !!p.severedArm;
      if (state.rig?.setSeveredLeg) state.rig.setSeveredLeg(state.local.severedLeg);
      if (state.rig?.setSeveredArm) state.rig.setSeveredArm(state.local.severedArm);
      // Server's authoritative sword tip (physics body position). Render local visual
      // toward this so the visible sword matches where damage is actually applied.
      if (p.weaponTip) {
        if (!state._serverTip) state._serverTip = new THREE.Vector3();
        state._serverTip.set(p.weaponTip.x, p.weaponTip.y, p.weaponTip.z);
      }
      state.local.stunMsLeft = p.stunMsLeft || 0;
      state.local.bleedMsLeft = p.bleedMsLeft || 0;
      state.local.torsoRot = p.torsoRot || null;
      state.local.headRot  = p.headRot  || null;
      state.local.commitMsLeft = p.commitMsLeft || 0;
      state._myScore = p.score || 0;
      state._myDeaths = p.deaths || 0;
      HUD.setHp(p.hp, RUNTIME.player.hp);
      HUD.setStatus({ stun: p.stunMsLeft || 0, bleed: p.bleedMsLeft || 0, cripple: p.crippleMsLeft || 0 });
      HUD.setStamina(p.stamina ?? 100, RUNTIME.player.stamina ?? 100);
      HUD.setDead(!p.alive);
      // Hard-snap on respawn so we don't lerp through walls back into the world.
      if (!wasAlive && p.alive) {
        state.local.pos.set(p.pos.x, p.pos.y, p.pos.z);
        state.local.vel.set(0, 0, 0);
        if (state.rig?.parts?.helm) state.rig.parts.helm.visible = true;
        if (state.rig?.root) state.rig.root.visible = true;
      }
      continue;
    }
    let r = state.remotes.get(p.id);
    if (!r || r.weaponKey !== p.weaponKey || r.color !== p.color) {
      if (r) { scene.remove(r.rig.root); }
      const pal = paletteFor(p.id, p.color);
      const grip = (RUNTIME.weapons[p.weaponKey]?.grip) || "one-hand";
      const rig = buildCharacter({ ...pal, weaponKey: p.weaponKey || "arming", grip });
      scene.add(rig.root);
      r = { rig, buf: [], hp: p.hp, name: p.name, score: 0, deaths: 0,
            weaponKey: p.weaponKey || "arming", color: p.color || 0,
            lastPos: { ...p.pos }, invulnMs: 0 };
      state.remotes.set(p.id, r);
    }
    r.buf.push({
      ts: performance.now(),
      pos: { ...p.pos },
      yaw: p.yaw,
      weaponTip: { ...p.weaponTip },
      hp: p.hp, alive: p.alive,
      invulnMs: p.invulnMs || 0,
    });
    const wasAliveR = r.alive;
    r.invulnMs = p.invulnMs || 0;
    r.crippleMsLeft = p.crippleMsLeft || 0;
    r.severedLeg = !!p.severedLeg;
    r.severedArm = !!p.severedArm;
    if (r.rig?.setSeveredLeg) r.rig.setSeveredLeg(r.severedLeg);
    if (r.rig?.setSeveredArm) r.rig.setSeveredArm(r.severedArm);
    r.stunMsLeft = p.stunMsLeft || 0;
    r.bleedMsLeft = p.bleedMsLeft || 0;
    r.disarmedMsLeft = p.disarmedMsLeft || 0;
    r.stamina = p.stamina ?? 100;
    r.torsoRot = p.torsoRot || null;
    r.headRot  = p.headRot  || null;
    // Restore detached helm + rig visibility on remote respawn.
    if (!wasAliveR && p.alive) {
      if (r.rig?.parts?.helm) r.rig.parts.helm.visible = true;
      if (r.rig?.root) r.rig.root.visible = true;
    }
    if (r.buf.length > 30) r.buf.shift();
    r.hp = p.hp;
    r.alive = p.alive;
    r.name = p.name;
    r.score = p.score;
    r.deaths = p.deaths;
  }

  // Server-authoritative arena props.
  if (m.props) syncServerProps(m.props);
  // Track latest sword positions for dropped-halo rendering.
  for (const p of m.players) {
    if (p.id === state.myId) continue;
    const r = state.remotes.get(p.id);
    if (r) r._lastTip = p.weaponTip;
  }

  // Match state.
  if (m.match) {
    state.match = m.match;
    HUD.setRoundTimer(m.match.phase, m.match.phaseMsLeft, m.match.roundMsLeft, m.match.round, m.match.scoreToWin);
  }

  // Rebuild scoreboard.
  const rows = m.players.map(p => ({ id: p.id, name: p.name, score: p.score, deaths: p.deaths }))
    .sort((a, b) => b.score - a.score || a.deaths - b.deaths);
  HUD.setScores(rows, state.myId);
});

net.on("hit", (m) => {
  // Audio (spatial pan).
  const sev = Math.min(1, m.dmg / 60);
  const pan = computePan(m.at);
  SFX.hit(sev, pan);
  if (m.to === state.myId) {
    HUD.flash(Math.min(0.6, 0.2 + m.dmg / 100));
    SFX.hurt();
    state.shake.mag = Math.max(state.shake.mag, 0.18 + sev * 0.35);
    state.shake.t = 0;
    // Directional indicator: angle from me toward attacker, in screen space.
    const attacker = state.remotes.get(m.from);
    if (attacker && attacker.buf.length) {
      const ap = attacker.buf[attacker.buf.length - 1].pos;
      const dx = ap.x - state.local.pos.x;
      const dz = ap.z - state.local.pos.z;
      // World yaw of attacker direction.
      const worldAngle = Math.atan2(dx, dz);
      // Subtract camera yaw to get screen-relative angle (camera "down" is screen up).
      const screenAngle = worldAngle - state.cameraYaw;
      HUD.hitFrom(screenAngle);
    }
  }
  if (m.kill) {
    SFX.death();
    const a = nameFor(m.from);
    const b = nameFor(m.to);
    const wpn = m.weapon ? `(${m.weapon})` : "";
    const z = m.zone === "head" ? " ⊕ HEAD" : m.zone === "legs" ? " ⊥ LEGS" : "";
    HUD.killFeed(`${a} ⚔ ${b} ${wpn}${z}`);
    if (m.from === state.myId) state.shake.mag = Math.max(state.shake.mag, 0.10);
    // Spawn ragdoll for the victim and hide their kinematic rig.
    const victim = m.to === state.myId ? null : state.remotes.get(m.to);
    const victimPos = victim ? victim.rig.root.position
                              : state.local.pos;
    const yaw = victim ? victim.rig.root.rotation.y : state.local.yaw;
    const pal = paletteFor(m.to);
    // Impulse direction: from attacker → victim.
    const attacker = m.from === state.myId ? { rig: state.rig, pos: state.local.pos } : state.remotes.get(m.from);
    const ax = attacker?.rig?.root?.position?.x ?? attacker?.pos?.x ?? 0;
    const az = attacker?.rig?.root?.position?.z ?? attacker?.pos?.z ?? 0;
    const dx = victimPos.x - ax, dz = victimPos.z - az;
    const dl = Math.hypot(dx, dz) || 1;
    const impulse = { x: dx / dl, y: 0, z: dz / dl };
    createRagdoll(scene, { x: victimPos.x, y: 0, z: victimPos.z }, yaw, pal.color, pal.accent, impulse);
    if (victim) victim.rig.root.visible = false;
    else if (state.rig) state.rig.root.visible = false;
  } else if (m.zone === "head") {
    HUD.killFeed(`⊕ headshot ${nameFor(m.from)} → ${nameFor(m.to)} (${m.dmg})`);
  }
  spark(scene, m.at, m.kill ? 0.6 : 0.3, m.zone === "head" ? 0xff5050 : 0xff8050);
  // Floating damage number at world hit point.
  if (m.dmg > 0 && m.at) {
    tmpProj.set(m.at.x, m.at.y + 0.4, m.at.z);
    tmpProj.project(camera);
    if (tmpProj.z >= -1 && tmpProj.z <= 1) {
      const sx = (tmpProj.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-tmpProj.y * 0.5 + 0.5) * window.innerHeight;
      const kind = m.to === state.myId ? "self" : (m.zone === "head" ? "head" : "out");
      HUD.damageNumber(String(m.dmg), sx, sy, kind);
    }
  }
  // Helm break (saved by helm OR lethal head): detach helmet visual.
  if (m.helmBreak || (m.kill && m.zone === "head")) {
    detachHelmet(m.to, m.at);
    if (m.helmBreak) SFX.ricochet(pan);
  }
  // Lethal head kill: extra sound.
  if (m.kill && m.zone === "head") SFX.death(pan);
  if (m.helmBreak && !m.kill) {
    HUD.killFeed(`⊕ helm broken — ${nameFor(m.to)} survives`);
  }
  // Track personal stats + remember killer for spectator camera.
  if (m.from === state.myId && m.kill) statsBump("kills");
  if (m.from === state.myId && m.dmg > 0) {
    state._dmgDealt = (state._dmgDealt || 0) + m.dmg;
    HUD.setDamageTotals(state._dmgDealt, state._dmgTaken || 0);
  }
  if (m.to === state.myId && m.dmg > 0) {
    state._dmgTaken = (state._dmgTaken || 0) + m.dmg;
    HUD.setDamageTotals(state._dmgDealt || 0, state._dmgTaken);
  }
  if (m.to === state.myId && m.kill) {
    statsBump("deaths");
    state.spectatorTargetId = m.from;
    state.spectatorOrbitT = 0;
  }
});

net.on("streak", (m) => {
  const who = m.id === state.myId ? "you" : (state.remotes.get(m.id)?.name ?? `#${m.id}`);
  const tag =
    m.count >= 10 ? "RAMPAGE"
    : m.count >= 7 ? "GODLIKE"
    : m.count >= 5 ? "BLOODBATH"
    : "TRIPLE KILL";
  HUD.killFeed(`★ ${tag} · ${who} (${m.count})`);
  if (m.id === state.myId) SFX.fanfare();
});

net.on("sever", (m) => {
  const pan = computePan(m.at);
  SFX.hit(0.9, pan);
  // Big blood burst.
  for (let i = 0; i < 6; i++) {
    spark(scene, m.at, 0.6, 0xa01515);
  }
  if (m.id === state.myId) {
    state.shake.mag = Math.max(state.shake.mag, 0.55);
    HUD.flash(0.5);
  }
  const limbWord = m.limb === "arm" ? "an arm" : "a leg";
  HUD.killFeed(`✂ ${nameFor(m.id)} loses ${limbWord}`);
});

net.on("knockdown", (m) => {
  const pan = computePan(m.at);
  SFX.thud(pan);
  spark(scene, m.at, 0.5, 0xa07050);
  if (m.id === state.myId) state.shake.mag = Math.max(state.shake.mag, 0.45);
});

net.on("bleed", (m) => {
  if (m.at) {
    spark(scene, m.at, 0.18, 0xa01515);
    tmpProj.set(m.at.x, m.at.y, m.at.z);
    tmpProj.project(camera);
    if (tmpProj.z >= -1 && tmpProj.z <= 1) {
      const sx = (tmpProj.x * 0.5 + 0.5) * window.innerWidth;
      const sy = (-tmpProj.y * 0.5 + 0.5) * window.innerHeight;
      HUD.damageNumber("-" + m.dmg, sx, sy, m.to === state.myId ? "self" : "out");
    }
  }
});

net.on("clash", (m) => {
  SFX.clash(computePan(m.at));
  spark(scene, m.at, 0.35, 0xfff0a0);
  if (m.a === state.myId || m.b === state.myId) {
    state.shake.mag = Math.max(state.shake.mag, 0.18);
    state.shake.t = 0;
  }
});

net.on("slam", (m) => {
  // Body slam: sprinting attacker drove victim back (and possibly knocked down).
  const pan = computePan(m.at);
  SFX.thud(pan);
  spark(scene, m.at, 0.32, 0xc8a070);
  if (m.to === state.myId) {
    state.shake.mag = Math.max(state.shake.mag, 0.32);
    state.shake.t = 0;
    HUD.flash(0.18);
  } else if (m.from === state.myId) {
    state.shake.mag = Math.max(state.shake.mag, 0.10);
  }
  HUD.killFeed(`⤳ ${nameFor(m.from)} body-slammed ${nameFor(m.to)}`);
});

net.on("wallClash", (m) => {
  // Sword-vs-wall/pillar clack. Quieter than parry, no shake.
  SFX.clash(computePan(m.at), Math.min(0.7, 0.3 + m.speed / 30));
  spark(scene, m.at, 0.18, 0xc8a97e);
  if (m.id === state.myId) {
    state.shake.mag = Math.max(state.shake.mag, 0.06);
    state.shake.t = 0;
  }
});

net.on("pickup", (m) => {
  // Rebuild rig with new weapon for the picker.
  if (m.id === state.myId) {
    if (state.rig) scene.remove(state.rig.root);
    const pal = paletteFor(state.myId);
    state.weaponKey = m.weapon;
    // Update RUNTIME.weapon so tip-inertia uses correct mass.
    if (RUNTIME.weapons[m.weapon]) RUNTIME.weapon = { ...RUNTIME.weapon, ...RUNTIME.weapons[m.weapon] };
    const grip = (RUNTIME.weapons[m.weapon]?.grip) || "one-hand";
    state.rig = buildCharacter({ ...pal, isLocal: true, weaponKey: m.weapon, grip });
    scene.add(state.rig.root);
    HUD.killFeed(`picked up ${m.weapon}`);
  } else {
    const r = state.remotes.get(m.id);
    if (r) {
      scene.remove(r.rig.root);
      const pal = paletteFor(m.id);
      const grip = (RUNTIME.weapons[m.weapon]?.grip) || "one-hand";
      r.rig = buildCharacter({ ...pal, weaponKey: m.weapon, grip });
      scene.add(r.rig.root);
      r.weaponKey = m.weapon;
    }
  }
  spark(scene, m.at, 0.3, 0x9adfff);
  SFX.click();
});

net.on("matchEnd", (m) => {
  const winName = m.winner === state.myId ? "you" : (state.remotes.get(m.winner)?.name ?? (m.winner ? `#${m.winner}` : "no one"));
  // Summary table from current snapshot of remote scores + local.
  const rows = [];
  if (state.local.alive !== undefined) {
    rows.push({ name: localStorage.getItem("ironyard.name") || "you", score: state._myScore || 0, deaths: state._myDeaths || 0, me: true });
  }
  for (const [id, r] of state.remotes) rows.push({ name: r.name, score: r.score || 0, deaths: r.deaths || 0, me: false });
  rows.sort((a, b) => b.score - a.score || a.deaths - b.deaths);
  const tableHtml = rows.map(r => `<tr style="${r.me ? 'color:#c8a97e;' : ''}">
    <td style="padding:.15rem .8rem; text-align:left;">${escapeHtml(r.name)}</td>
    <td style="padding:.15rem .8rem;">${r.score}</td>
    <td style="padding:.15rem .8rem; opacity:.6;">${r.deaths}</td></tr>`).join("");
  const reasonNote = m.reason === "timeout" ? "time over" : "first to score";
  const mvpHtml = m.mvp
    ? `<div style="font-size:.85rem; color:#ffd060; margin:.3rem 0;">MVP · ${escapeHtml(m.mvp.name)} · ${m.mvp.dmg} dmg</div>`
    : "";
  HUD.showBanner(
    `<div style="font-size:1.4rem;">ROUND ${m.round} · ${escapeHtml(winName)} wins</div>
     <div style="font-size:.7rem; opacity:.6; letter-spacing:.2em; margin:.2rem 0 .6rem;">${reasonNote}</div>
     ${mvpHtml}
     <table style="margin: 0 auto; font-size:.85rem; border-collapse:collapse;">
       <thead><tr style="opacity:.6;"><th style="padding:.15rem .8rem; text-align:left;">name</th><th>K</th><th>D</th></tr></thead>
       <tbody>${tableHtml}</tbody>
     </table>
     <div style="font-size:.75rem; opacity:.5; margin-top:.6rem;">next round soon…</div>`
  );
  if (m.winner === state.myId) {
    statsBump("wins");
  } else {
    statsBump("losses");
  }
  SFX.fanfare();
});
net.on("matchStart", (m) => {
  HUD.hideBanner();
  HUD.showBanner(`<div>ROUND ${m.round} · BEGIN</div>`, 1500);
  HUD.killFeed("— new round —");
});
net.on("join",  (m) => HUD.log(`${m.player.name} joined`));
net.on("leave", (m) => {
  const r = state.remotes.get(m.id);
  if (r) { scene.remove(r.rig.root); state.remotes.delete(m.id); }
});
net.on("full",  () => { net.disconnect(); HUD.setMenu(true, "arena full — try later"); });
net.on("close", () => {
  window.IRONYARD_INGAME = false;
  HUD.log("disconnected — reconnecting…");
});
net.on("open",   () => { /* fresh connect */ });
net.on("reopen", () => { HUD.log("reconnected"); window.IRONYARD_INGAME = true; });
net.on("chat",  (m) => HUD.log(`${m.name}: ${m.text}`));

function nameFor(id) {
  if (id === 0) return "bleeding";          // bleed-out kill (no attacker)
  if (id === state.myId) return "you";
  const r = state.remotes.get(id);
  return r?.name ?? `#${id}`;
}

// ---------- Tick / render ----------
let lastFrame = performance.now();
function frame(t) {
  const dt = Math.min(0.05, (t - lastFrame) / 1000);
  lastFrame = t;

  const inp = input.sample(dt);

  if (state.rig && !state.local.alive) {
    // Local player dead — freeze input, just animate slumped pose.
    state.rig.animate(dt, { mvSpeed: 0, swinging: false, blocking: false, alive: false });
    state.rig.root.position.copy(state.local.pos);
    state.rig.root.rotation.y = state.local.yaw;
  }
  if (state.rig && state.local.alive) {
    // Player faces wherever the camera is pointing (third-person standard). Mouse +
    // right-stick drive the camera, so they also drive facing — no second-stick aim.
    state.local.yaw = lerpAngle(state.local.yaw, state.cameraYaw, Math.min(1, dt * 14));

    // Movement world vector — PLAYER-relative (avoids camera-yaw feedback loop).
    // Stick up / W = inp.mv.y < 0 → walk in player's forward direction.
    // Player forward (XZ): (-sin(yaw), -cos(yaw)). Right: (cos(yaw), -sin(yaw)).
    const fwdX = -Math.sin(state.local.yaw), fwdZ = -Math.cos(state.local.yaw);
    const rgtX =  Math.cos(state.local.yaw), rgtZ = -Math.sin(state.local.yaw);
    const mvWX = rgtX * inp.mv.x + fwdX * (-inp.mv.y);
    const mvWZ = rgtZ * inp.mv.x + fwdZ * (-inp.mv.y);
    const mvLen = Math.hypot(mvWX, mvWZ);
    let mvNX = 0, mvNZ = 0;
    if (mvLen > 0.001) { mvNX = mvWX / Math.max(1, mvLen); mvNZ = mvWZ / Math.max(1, mvLen); }
    const baseSpeed = RUNTIME.player.moveSpeed ?? 4.5;
    const sprintMult = RUNTIME.player.sprintMult ?? 1.6;
    const speed = baseSpeed * (inp.sprint ? sprintMult : 1) * (inp.block ? 0.55 : 1);
    // Predict locally; server reconciles via snapshots.
    state.local.pos.x += mvNX * speed * dt;
    state.local.pos.z += mvNZ * speed * dt;
    // Track an approximate horizontal velocity for prop-kick + UX hooks.
    state.local.vel.x = mvNX * speed;
    state.local.vel.z = mvNZ * speed;
    if (inp.jump && state.local.onGround) { state.local.vel.y = 5.5; state.local.onGround = false; }
    state.local.vel.y += -18 * dt;
    state.local.pos.y += state.local.vel.y * dt;
    if (state.local.pos.y <= 0) { state.local.pos.y = 0; state.local.vel.y = 0; state.local.onGround = true; }
    // Soft arena clamp.
    const half = (RUNTIME.arena.size / 2) - 0.4;
    if (state.local.pos.x < -half) state.local.pos.x = -half;
    if (state.local.pos.x >  half) state.local.pos.x =  half;
    if (state.local.pos.z < -half) state.local.pos.z = -half;
    if (state.local.pos.z >  half) state.local.pos.z =  half;

    // Attack state — start a new attack on edge trigger if no active attack (or the
    // active one is past its 60% mark, so successive clicks chain).
    if (inp.attackTrigger) {
      const paths = pathsFor(state.weaponKey);
      const dur = (paths[inp.attackTrigger] ?? ATTACK_PATHS[inp.attackTrigger])?.duration ?? 380;
      // Heavier weapons take longer to arc. Mass scales duration up to ~1.5x.
      const wMassDur = (RUNTIME.weapon.mass || 1.0);
      const scaledDur = Math.round(dur * (0.85 + 0.18 * Math.min(2.0, wMassDur)));
      state.attack = { type: inp.attackTrigger, start: performance.now(), duration: scaledDur };
    }

    // Compute target weapon tip from attack state (or rest). Send target to server,
    // and render the local sword toward the scripted target directly (client-side
    // prediction — keeps input → visual instant). Server stays authoritative for
    // damage; small visual/damage divergence on heavy weapons is acceptable.
    state.weaponTipPrev.copy(state.weaponTipWorld);
    const mvSpeed = Math.hypot(mvWX, mvWZ) * speed;
    const myGrip = RUNTIME.weapons[state.weaponKey]?.grip || "one-hand";
    computeAttackTipTarget(state, state.local.pos, state.local.yaw, mvSpeed, state.weaponKey, myGrip, state.weaponTipTarget);
    const wMass = RUNTIME.weapon.mass || 1.0;
    // Heavier weapons lag the target more — feels weighty.
    const k = Math.min(1, dt * (14 / wMass));
    state.weaponTipWorld.lerp(state.weaponTipTarget, k);
    state.weaponTipVel.subVectors(state.weaponTipWorld, state.weaponTipPrev).divideScalar(Math.max(dt, 1 / 240));

    // Pose rig.
    poseRig(state.rig, state.local.pos, state.local.yaw, state.weaponTipWorld);
    // Decompose tip velocity into player-local axes for body-lean animation.
    const cy = Math.cos(-state.local.yaw), sy = Math.sin(-state.local.yaw);
    const swingLat =  cy * state.weaponTipVel.x + sy * state.weaponTipVel.z;
    const swingFwd = -sy * state.weaponTipVel.x + cy * state.weaponTipVel.z;
    // Distance from shoulder to current world tip (for elbow IK).
    shoulderWorld(state.local.pos, state.local.yaw, tmpV);
    const tipDistLocal = state.weaponTipWorld.distanceTo(tmpV);
    state.rig.animate(dt, {
      mvSpeed, swinging: state.weaponTipVel.length() > 4, blocking: !!inp.block,
      alive: state.local.alive, swingLat, swingFwd,
      crippled: (state.local.crippleMsLeft || 0) > 0,
      stunned:  (state.local.stunMsLeft    || 0) > 0,
      verAim:   verAimFromAttack(state.attack),
      tipDist:  tipDistLocal,
      torsoRot: state.local.torsoRot,
      headRot:  state.local.headRot,
      playerYaw: state.local.yaw,
    });
    state.rig.setInvuln((state.local.invulnMs || 0) > 0, performance.now() / 1000);
    state.rig.pushTrail(state.weaponTipWorld, state.weaponTipVel.length());

    // Bleed drip for local player.
    if ((state.local.bleedMsLeft || 0) > 0) {
      state._bleedT = (state._bleedT || 0) + dt;
      if (state._bleedT > 0.18) {
        state._bleedT = 0;
        const p = state.local.pos;
        spark(scene, { x: p.x + (Math.random() - 0.5) * 0.4, y: 0.8 + Math.random() * 0.4, z: p.z + (Math.random() - 0.5) * 0.4 }, 0.12, 0xa01515);
      }
    }
    // Footsteps when on ground and moving.
    if (state.local.onGround && mvSpeed > 1) {
      state.footstepPhase += dt * (mvSpeed * 0.45 + 1.5);
      if (state.footstepPhase >= Math.PI) {
        state.footstepPhase -= Math.PI;
        SFX.footstep();
      }
    } else {
      state.footstepPhase = 0;
    }

    // Whoosh on rapid sword motion (rate-limited).
    const tipSpeed = state.weaponTipVel.length();
    if (tipSpeed > 6 && performance.now() - state.swingPlayedAt > 220) {
      SFX.whoosh(Math.min(1, (tipSpeed - 4) / 14));
      state.swingPlayedAt = performance.now();
    }
  }

  // Send input at 60Hz.
  if (state.serverConfigReceived && performance.now() - state.lastInputSentAt > (1000 / CLIENT.INPUT_HZ)) {
    state.lastInputSentAt = performance.now();
    state.inputSeq++;
    // Movement is player-relative. Server expects mv.y > 0 = forward; our input has
    // stick-up / W as mv.y < 0, so negate.
    const mvOut = { x: inp.mv.x, y: -inp.mv.y };

    net.send({
      t: "input",
      seq: state.inputSeq,
      mv: mvOut,
      yaw: state.local.yaw,
      pitch: 0,
      sprint: !!inp.sprint,
      jump: !!inp.jump,
      blocking: !!inp.block,
      swinging: true,           // always live; server gates on tip speed
      // Send the SCRIPTED TARGET (what the attack path wants), NOT the rendered tip.
      // The rendered tip is mirrored back from the server, so sending it would create
      // a feedback loop and the spring would have no error to drive.
      weaponTip: { x: state.weaponTipTarget.x, y: state.weaponTipTarget.y, z: state.weaponTipTarget.z },
    });
  }

  // Interpolate remotes.
  const renderTime = performance.now() - CLIENT.INTERP_DELAY_MS;
  for (const r of state.remotes.values()) {
    interpolateRemote(r, renderTime);
  }

  // Camera is independent of player yaw / mouse aim. It only rotates from explicit
  // user input (ALT+mouse drag while pointer-locked, ◄ ► touch buttons, Q/E keys).
  state.cameraYaw   += inp.cameraYawDelta || 0;
  if (inp.cameraPitchDelta) state.cameraPitch += inp.cameraPitchDelta;
  state.cameraPitch = Math.max(0.05, Math.min(1.2, state.cameraPitch));
  state.cameraDist = clamp(state.cameraDist + inp.zoomDelta, 2.5, 9);

  // Spectator: when dead, look at the killer (or nearest alive enemy) and slowly orbit.
  let lookTargetPos = state.local.pos;
  if (!state.local.alive) {
    state.spectatorOrbitT += dt;
    let target = null;
    if (state.spectatorTargetId != null) target = state.remotes.get(state.spectatorTargetId);
    if (!target || !target.alive) {
      // Pick first alive remote.
      for (const r of state.remotes.values()) {
        if (r.alive) { target = r; state.spectatorTargetId = null; break; }
      }
    }
    if (target) {
      lookTargetPos = target.rig.root.position;
      state.cameraYaw += dt * 0.35;   // slow orbit
    }
  }
  // Raycast from target (player chest) to ideal camera position; if a wall/pillar is in
  // the way, pull the camera in to that hit point so we don't see through geometry.
  const camLookAt = new THREE.Vector3(lookTargetPos.x, lookTargetPos.y + 1.4, lookTargetPos.z);
  // Spherical offset: yaw around player, pitch tilts up.
  const cosP = Math.cos(state.cameraPitch);
  const sinP = Math.sin(state.cameraPitch);
  const offX = Math.sin(state.cameraYaw) * state.cameraDist * cosP;
  const offZ = Math.cos(state.cameraYaw) * state.cameraDist * cosP;
  const offY = state.cameraDist * sinP;
  const idealOff = new THREE.Vector3(offX, offY, offZ);
  const idealPos = camLookAt.clone().add(idealOff);
  const dir = idealPos.clone().sub(camLookAt);
  const dist = dir.length();
  dir.normalize();
  state._raycaster ??= new THREE.Raycaster();
  state._raycaster.set(camLookAt, dir);
  state._raycaster.far = dist;
  // Limit hit objects to scene root (skip skinning); use recursive search.
  const hits = state._raycaster.intersectObjects(scene.children, true).filter(h => {
    // Ignore the local rig + nameplates etc. Allow walls/pillars/ground (Mesh).
    if (!h.object.isMesh) return false;
    const root = state.rig?.root;
    if (root) {
      let p = h.object;
      while (p) { if (p === root) return false; p = p.parent; }
    }
    return true;
  });
  let useDist = dist;
  if (hits.length) useDist = Math.max(1.5, hits[0].distance - 0.2);
  const camPos = camLookAt.clone().addScaledVector(dir, useDist);
  camera.position.copy(camPos);
  camera.lookAt(camLookAt);

  // Screen shake — small offset to camera AFTER lookAt.
  if (state.shake.mag > 0.001) {
    state.shake.t += dt;
    const decay = Math.exp(-state.shake.t * state.shake.decay);
    const m = state.shake.mag * decay;
    camera.position.x += (Math.random() - 0.5) * m;
    camera.position.y += (Math.random() - 0.5) * m;
    camera.position.z += (Math.random() - 0.5) * m;
    if (m < 0.01) state.shake.mag = 0;
  }

  // Torch flicker.
  const torches = scene.userData?._torches;
  if (torches) {
    const tNow = performance.now() / 1000;
    for (const t of torches) {
      const f = 0.85 + 0.15 * Math.sin(tNow * 12 + t.phase) + 0.10 * Math.sin(tNow * 23 + t.phase);
      t.light.intensity = 1.0 + f * 0.6;
      t.flame.scale.y = 0.85 + f * 0.30;
    }
  }

  // Physics tick (ragdolls + arena props).
  rapierStep(dt);
  tickRagdolls();
  if (state.local.alive) {
    applyKickToProps(state.local.pos, state.local.vel);
  }
  syncProps();

  HUD.setStance(stanceLabel(inp));
  updateNameplates();
  updateDroppedSwordHalos();
  tickFallingProps(dt);

  // Lock-hint overlay: visible only after we've joined and pointer isn't locked.
  const hint = document.getElementById("lock-hint");
  if (hint) {
    const inGame = state.serverConfigReceived;
    const locked = document.pointerLockElement != null;
    hint.style.display = (inGame && !locked && !input.touchActive) ? "block" : "none";
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function interpolateRemote(r, renderTime) {
  if (!r.buf.length) return;
  let i = r.buf.length - 1;
  while (i > 0 && r.buf[i].ts > renderTime) i--;
  const a = r.buf[i], b = r.buf[Math.min(i + 1, r.buf.length - 1)];
  let t = 0;
  if (a !== b && b.ts !== a.ts) t = clamp((renderTime - a.ts) / (b.ts - a.ts), 0, 1);
  const pos = {
    x: a.pos.x + (b.pos.x - a.pos.x) * t,
    y: a.pos.y + (b.pos.y - a.pos.y) * t,
    z: a.pos.z + (b.pos.z - a.pos.z) * t,
  };
  let yaw = lerpAngle(a.yaw, b.yaw, t);
  const tip = {
    x: a.weaponTip.x + (b.weaponTip.x - a.weaponTip.x) * t,
    y: a.weaponTip.y + (b.weaponTip.y - a.weaponTip.y) * t,
    z: a.weaponTip.z + (b.weaponTip.z - a.weaponTip.z) * t,
  };
  const tipV = new THREE.Vector3(tip.x, tip.y, tip.z);
  const posV = new THREE.Vector3(pos.x, pos.y, pos.z);
  poseRig(r.rig, posV, yaw, tipV);

  // Estimate movement speed from interpolation buffer (last two snaps).
  const snapDtMs = Math.max(1, b.ts - a.ts);
  const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
  const mvSpeed = Math.hypot(dx, dz) / (snapDtMs / 1000);
  // Approximate shoulder→tip distance for elbow IK.
  shoulderWorld(posV, yaw, tmpV);
  const remoteTipDist = tipV.distanceTo(tmpV);
  // verAim approximated from tip's vertical offset above shoulder.
  const remoteVerAim = (tipV.y - tmpV.y) / Math.max(0.5, RUNTIME.weapon.length || 1);
  r.rig.animate(1 / 60, {
    mvSpeed, swinging: false, blocking: false, alive: !!r.alive,
    crippled: (r.crippleMsLeft || 0) > 0,
    stunned:  (r.stunMsLeft    || 0) > 0,
    verAim: remoteVerAim,
    tipDist: remoteTipDist,
    torsoRot: r.torsoRot,
    headRot:  r.headRot,
    playerYaw: yaw,
  });
  r.rig.setInvuln((r.invulnMs || 0) > 0, performance.now() / 1000);
  // Estimate tip speed from snap delta to drive trail.
  const tipDx = b.weaponTip.x - a.weaponTip.x;
  const tipDy = b.weaponTip.y - a.weaponTip.y;
  const tipDz = b.weaponTip.z - a.weaponTip.z;
  const tipSpd = Math.hypot(tipDx, tipDy, tipDz) / Math.max(0.001, snapDtMs / 1000);
  r.rig.pushTrail(tipV, tipSpd);

  // Bleed drip particles — small red puffs along the body when bleeding.
  if (r.alive && (r.bleedMsLeft || 0) > 0) {
    r._bleedT = (r._bleedT || 0) + 1 / 60;
    if (r._bleedT > 0.18) {
      r._bleedT = 0;
      const p = r.rig.root.position;
      spark(scene, { x: p.x + (Math.random() - 0.5) * 0.4, y: 0.8 + Math.random() * 0.4, z: p.z + (Math.random() - 0.5) * 0.4 }, 0.12, 0xa01515);
    }
  }

  // Positional footstep audio.
  if (r.alive && mvSpeed > 1) {
    r._stepPhase = (r._stepPhase || 0) + (1 / 60) * (mvSpeed * 0.45 + 1.5);
    if (r._stepPhase >= Math.PI) {
      r._stepPhase -= Math.PI;
      const pan = computePan(r.rig.root.position);
      const ddx = r.rig.root.position.x - state.local.pos.x;
      const ddz = r.rig.root.position.z - state.local.pos.z;
      const dist = Math.hypot(ddx, ddz);
      const dampen = Math.max(0.05, Math.min(0.7, 6 / Math.max(1, dist)));
      SFX.footstep(pan, dampen);
    }
  }

  if (!r.alive) {
    r.rig.root.position.y = 0.0;
  } else {
    r.rig.root.position.y = pos.y;
  }
}

// Halo over each dropped (unowned) enemy sword.
const swordHaloMap = new Map();   // remote.id -> Mesh
function updateDroppedSwordHalos() {
  const seen = new Set();
  for (const [id, r] of state.remotes) {
    const dropped = !r.alive
      || (r.stunMsLeft || 0) > 0
      || (r.disarmedMsLeft || 0) > 0
      || r.severedArm;
    if (!dropped || !r._lastTip) continue;
    seen.add(id);
    let halo = swordHaloMap.get(id);
    if (!halo) {
      const geo = new THREE.RingGeometry(0.20, 0.32, 24);
      const mat = new THREE.MeshBasicMaterial({ color: 0x9adfff, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
      halo = new THREE.Mesh(geo, mat);
      halo.rotation.x = -Math.PI / 2;
      scene.add(halo);
      swordHaloMap.set(id, halo);
    }
    const t = r._lastTip;
    halo.position.set(t.x, 0.06, t.z);
    halo.rotation.z = (performance.now() / 1000) * 1.5;
  }
  for (const [id, halo] of swordHaloMap) {
    if (!seen.has(id)) { scene.remove(halo); swordHaloMap.delete(id); }
  }
}

// Server-authoritative arena props: build/sync from snap.props each frame.
const serverPropMeshes = [];
function syncServerProps(propsArr) {
  if (!propsArr) return;
  // Lazy-build meshes the first time we see N props.
  while (serverPropMeshes.length < propsArr.length) {
    const radius = 0.45, height = 0.95;
    const grp = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.9 });
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });
    const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 12), mat);
    m.castShadow = true; m.receiveShadow = true;
    grp.add(m);
    for (const off of [-0.30, 0, 0.30]) {
      const r = new THREE.Mesh(new THREE.TorusGeometry(radius * 0.96, 0.04, 6, 16), ringMat);
      r.position.y = off;
      r.rotation.x = Math.PI / 2;
      grp.add(r);
    }
    scene.add(grp);
    serverPropMeshes.push(grp);
  }
  for (let i = 0; i < propsArr.length; i++) {
    const p = propsArr[i];
    const m = serverPropMeshes[i];
    if (!m) continue;
    m.position.set(p.pos.x, p.pos.y, p.pos.z);
    m.quaternion.set(p.rot.x, p.rot.y, p.rot.z, p.rot.w);
  }
}

// Project remote players' world-positions to screen and update nameplate divs.
const npRoot = document.getElementById("nameplates");
const npMap = new Map();   // id -> div
const tmpProj = new THREE.Vector3();
function updateNameplates() {
  if (!npRoot) return;
  const seen = new Set();
  for (const [id, r] of state.remotes) {
    if (!r.alive) continue;
    seen.add(id);
    let div = npMap.get(id);
    if (!div) {
      div = document.createElement("div");
      div.className = "np" + (r.name?.startsWith("[bot]") ? " bot" : "");
      div.innerHTML = `<div class="name"></div>
        <div class="hp-mini"><div class="hp-mini-fill"></div></div>
        <div class="sta-mini"><div class="sta-mini-fill"></div></div>`;
      npRoot.append(div);
      npMap.set(id, div);
    }
    const pos = r.rig.root.position;
    tmpProj.set(pos.x, pos.y + 2.05, pos.z);
    tmpProj.project(camera);
    if (tmpProj.z > 1 || tmpProj.z < -1) { div.style.display = "none"; continue; }
    const sx = (tmpProj.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-tmpProj.y * 0.5 + 0.5) * window.innerHeight;
    div.style.left = sx + "px";
    div.style.top = sy + "px";
    div.style.display = "block";
    // Append small status icons after weapon name.
    const status = [];
    if ((r.stunMsLeft || 0) > 0)     status.push("STUN");
    if ((r.disarmedMsLeft || 0) > 0) status.push("DISARM");
    if ((r.bleedMsLeft || 0) > 0)    status.push("BLEED");
    if ((r.crippleMsLeft || 0) > 0)  status.push("LEG");
    const statusHtml = status.length ? ` <span style="color:#ff8050;">${status.join(" ")}</span>` : "";
    div.querySelector(".name").innerHTML = `${escapeHtml(r.name)} · ${escapeHtml(r.weaponKey || "")}${statusHtml}`;
    div.querySelector(".hp-mini-fill").style.width = Math.max(0, Math.min(100, (r.hp / (RUNTIME.player.hp || 100)) * 100)).toFixed(1) + "%";
    const staMax = (RUNTIME.player.stamina || 100);
    const sta = Math.max(0, Math.min(100, ((r.stamina ?? staMax) / staMax) * 100));
    div.querySelector(".sta-mini-fill").style.width = sta.toFixed(1) + "%";
  }
  // Remove nameplates for players gone.
  for (const [id, div] of npMap) {
    if (!seen.has(id)) { div.remove(); npMap.delete(id); }
  }
}

// Compute stereo pan -1..1 for a world point relative to the camera frame.
const tmpPan = new THREE.Vector3();
function computePan(at) {
  if (!at) return 0;
  tmpPan.set(at.x, at.y, at.z);
  tmpPan.project(camera);
  return Math.max(-1, Math.min(1, tmpPan.x));
}

// Detach helmet visual from a victim. The helm becomes a Rapier dynamic body and
// physically tumbles + rolls. Original helm on the rig is hidden until respawn.
function detachHelmet(victimId, at) {
  let rig = victimId === state.myId ? state.rig : state.remotes.get(victimId)?.rig;
  if (!rig) return;
  const helm = rig.parts?.helm;
  if (!helm || !helm.parent) return;
  const wp = new THREE.Vector3();
  helm.getWorldPosition(wp);
  const wq = new THREE.Quaternion();
  helm.getWorldQuaternion(wq);
  const m = helm.clone(true);
  m.position.copy(wp);
  m.quaternion.copy(wq);
  m.scale.copy(helm.scale);
  helm.visible = false;
  // Direction: from rig center toward hit point (or random if no hit point).
  let dir = { x: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2 };
  if (at) {
    const dx = at.x - wp.x;
    const dz = at.z - wp.z;
    const dl = Math.hypot(dx, dz) || 1;
    dir = { x: dx / dl, z: dz / dl };
  }
  spawnFallingHelm(scene, m, wp, dir, () => {
    // On expire: restore the live rig's helm visibility (in case the player respawned).
    if (rig.parts?.helm) rig.parts.helm.visible = true;
  });
}
function tickFallingProps(dt) {
  // Helm physics is now driven by Rapier (see ragdoll.js tickRagdolls). Kept as a
  // no-op so the existing call site in frame() doesn't change.
  void dt;
}

// Hit spark.
function spark(scene, at, scale = 0.3, color = 0xff8050) {
  const g = new THREE.SphereGeometry(0.05, 8, 6);
  const m = new THREE.MeshBasicMaterial({ color });
  const dots = [];
  for (let i = 0; i < 12; i++) {
    const d = new THREE.Mesh(g, m);
    d.position.set(at.x, at.y, at.z);
    d.userData.v = new THREE.Vector3((Math.random() - 0.5), Math.random() * 0.8, (Math.random() - 0.5)).multiplyScalar(scale * 4);
    scene.add(d);
    dots.push(d);
  }
  const start = performance.now();
  const tick = () => {
    const dt = 1 / 60;
    const elapsed = (performance.now() - start) / 1000;
    for (const d of dots) {
      d.position.x += d.userData.v.x * dt;
      d.position.y += d.userData.v.y * dt;
      d.position.z += d.userData.v.z * dt;
      d.userData.v.y -= 9 * dt;
    }
    if (elapsed < 0.6) requestAnimationFrame(tick);
    else for (const d of dots) scene.remove(d);
  };
  tick();
}

function stanceLabel(inp) {
  if ((state.local.commitMsLeft || 0) > 0) return "★ COMMIT ★";
  if (inp.block) return "— guard —";
  if (state.attack && state.attack.type) {
    return `— ${state.attack.type} —`;
  }
  return "— at rest —";
}

// Map current attack state to a "vertical aim" hint that drives the rig's shoulder
// lift animation (overhead = lifted shoulder, stab = neutral, swings = neutral).
function verAimFromAttack(att) {
  if (!att) return 0;
  if (att.type === "overhead") return 0.6;
  if (att.type === "stab")     return 0.0;
  return 0.1;
}

// ---------- Menu / connect ----------
function autoServerUrl() {
  // If page served over http(s), assume ws on same host:port. Override via ?ws=...
  const params = new URLSearchParams(location.search);
  if (params.get("ws")) return params.get("ws");
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  // Vite dev runs at 5173, but server runs at 8080 in dev — try 8080 if local.
  if (location.port === "5173") return `${proto}//${location.hostname}:8080`;
  return `${proto}//${location.host}`;
}

function autoName() {
  const stored = localStorage.getItem("ironyard.name");
  if (stored) return stored;
  const animals = ["wolf","raven","bear","fox","stag","hawk","boar","ash","oak","iron","grim","red"];
  const a = animals[(Math.random() * animals.length) | 0];
  return `${a}-${(Math.random() * 1000) | 0}`;
}

const nameInput = document.getElementById("name");
const serverInput = document.getElementById("server");
const enterBtn = document.getElementById("enter");
const params = new URLSearchParams(location.search);
nameInput.value = params.get("name") || autoName();
serverInput.value = autoServerUrl();
serverInput.style.display = "none";
if (params.get("dev")) serverInput.style.display = "";

// Weapon picker.
const WEAPON_BLURBS = {
  arming:      "Arming sword — balanced one-hand. Quick, reliable.",
  longsword:   "Longsword — two-hand reach, heavier swings, big damage.",
  mace:        "Mace — short, blunt, brutal. Ignores some block reduction.",
  spear:       "Spear — two-hand thrusting weapon. Longest reach. +40% on thrust.",
  swordshield: "Sword + shield — one-hand sword with shield. +20% block reduction.",
};
const blurbEl = document.getElementById("weapon-blurb");
const wpnBtns = [...document.querySelectorAll("button.weapon")];
function setWeapon(key) {
  state.weaponKey = key;
  localStorage.setItem("ironyard.weapon", key);
  for (const b of wpnBtns) b.classList.toggle("active", b.dataset.weapon === key);
  if (blurbEl) blurbEl.textContent = WEAPON_BLURBS[key] || "";
}
const initialWeapon = params.get("weapon") || localStorage.getItem("ironyard.weapon") || "arming";
setWeapon(WEAPON_LIST.includes(initialWeapon) ? initialWeapon : "arming");
for (const b of wpnBtns) {
  b.addEventListener("click", () => { SFX.unlockAudio(); SFX.click(); setWeapon(b.dataset.weapon); });
}

// Color picker.
const colorBtns = [...document.querySelectorAll("button.color-swatch")];
function setColor(hex) {
  state.colorPick = hex;
  localStorage.setItem("ironyard.color", String(hex));
  for (const b of colorBtns) b.classList.toggle("active", parseInt(b.dataset.color) === hex);
}
const initialColor = parseInt(localStorage.getItem("ironyard.color") || "0x6b8a9a");
setColor(Number.isFinite(initialColor) ? initialColor : 0x6b8a9a);
for (const b of colorBtns) {
  b.addEventListener("click", () => { SFX.unlockAudio(); SFX.click(); setColor(parseInt(b.dataset.color)); });
}

// Career stats display.
const careerEl = document.getElementById("career");
if (careerEl) careerEl.textContent = "career · " + statsHtml();

// ---- In-game chat ----
const chatInput = document.getElementById("chat-input");
if (chatInput) {
  window.addEventListener("keydown", (e) => {
    if (!window.IRONYARD_INGAME) return;
    // Open chat with T or /. Ignore if already focused on a slider/button.
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (chatInput.style.display === "none" && (e.code === "KeyT" || e.code === "Slash") && tag !== "INPUT") {
      // Release pointer-lock so the user can type.
      document.exitPointerLock?.();
      chatInput.style.display = "block";
      chatInput.value = e.code === "Slash" ? "/" : "";
      requestAnimationFrame(() => chatInput.focus());
      e.preventDefault();
    }
  });
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const text = chatInput.value.trim();
      if (text.length) net.send({ t: "chat", text });
      chatInput.value = "";
      chatInput.style.display = "none";
      chatInput.blur();
      e.preventDefault();
    } else if (e.key === "Escape") {
      chatInput.value = "";
      chatInput.style.display = "none";
      chatInput.blur();
      e.preventDefault();
    }
    // Don't let movement keys bubble while typing.
    e.stopPropagation();
  });
}

// ---- Settings panel ----
function loadSettings() {
  try { return JSON.parse(localStorage.getItem("ironyard.settings") || "{}"); }
  catch { return {}; }
}
function saveSettings(s) { try { localStorage.setItem("ironyard.settings", JSON.stringify(s)); } catch {} }

const SETTINGS = Object.assign({
  volume: 55, fov: 70, sens: 40, camdist: 4.2,
}, loadSettings());

function applySettingsLive() {
  SFX.setMasterVolume(SETTINGS.volume / 100);
  if (camera && camera.fov !== SETTINGS.fov) {
    camera.fov = SETTINGS.fov;
    camera.updateProjectionMatrix();
  }
  state.cameraDist = SETTINGS.camdist;
  window.IRONYARD_SETTINGS = SETTINGS;
}
applySettingsLive();

const settingsBtn = document.getElementById("settings-btn");
const settingsPanel = document.getElementById("settings");
if (settingsBtn && settingsPanel) {
  settingsBtn.addEventListener("click", () => {
    settingsPanel.style.display = settingsPanel.style.display === "block" ? "none" : "block";
  });
}
function bindSlider(id, key, format = (v) => v) {
  const el = document.getElementById(id);
  const num = document.getElementById(id + "-num");
  if (!el) return;
  el.value = SETTINGS[key];
  if (num) num.textContent = format(SETTINGS[key]);
  el.addEventListener("input", () => {
    const v = parseFloat(el.value);
    SETTINGS[key] = v;
    if (num) num.textContent = format(v);
    saveSettings(SETTINGS);
    applySettingsLive();
  });
}
bindSlider("set-volume", "volume");
bindSlider("set-fov",    "fov");
bindSlider("set-sens",   "sens");
bindSlider("set-camdist","camdist", (v) => v.toFixed(1));

async function play() {
  SFX.unlockAudio();   // first user gesture — required for Web Audio
  SFX.click();
  // Default to fullscreen — must be triggered from the PLAY click (user gesture).
  try {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (req && !document.fullscreenElement) await req.call(el);
    // Lock to landscape on touch devices (Android Chrome supports this; iOS will throw).
    if (screen.orientation && screen.orientation.lock) {
      try { await screen.orientation.lock("landscape"); } catch {}
    }
  } catch (e) { /* user denied or unsupported — fine */ }
  // Init Rapier physics (client-side ragdolls). Idempotent — safe to await each PLAY.
  try { await initRapier(); } catch (e) { console.warn("rapier init failed:", e); }
  const name = nameInput.value.trim() || autoName();
  localStorage.setItem("ironyard.name", name);
  const url = serverInput.value.trim() || autoServerUrl();
  HUD.setMenu(true, "connecting…");
  try {
    await net.connect(url);
    // Persistent per-browser session id so the server can resume our slot if WS drops.
    let sessionId = localStorage.getItem("ironyard.session");
    if (!sessionId) {
      sessionId = (crypto.randomUUID && crypto.randomUUID()) ||
                  Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem("ironyard.session", sessionId);
    }
    const joinMsg = { t: "join", name, weapon: state.weaponKey, sessionId, color: state.colorPick };
    net.rememberJoin(joinMsg);
    net.send(joinMsg);
    HUD.setMenu(false);
    window.IRONYARD_INGAME = true;
    SFX.startAmbientWind();
    requestAnimationFrame(frame);
    setInterval(() => net.sendPing(), 1000);
    setInterval(() => HUD.setPing(net.rtt), 500);
  } catch (err) {
    HUD.setMenu(true, "could not connect — server offline?");
  }
}
enterBtn.addEventListener("click", play);
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") play(); });

if (params.get("auto")) play();
