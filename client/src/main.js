import * as THREE from "three";
import { CLIENT, RUNTIME, applyRuntime } from "./config.js";
import { Net } from "./network.js";
import { Input } from "./input.js";
import { buildScene } from "./scene.js";
import { buildCharacter, WEAPON_LIST } from "./character.js";
import { HUD } from "./hud.js";
import * as SFX from "./audio.js";

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
};

// ---------- Color palette per id ----------
const PALETTE = [
  { color: 0x6b8a9a, accent: 0xc8a97e },  // blue-gray
  { color: 0x8a6b5a, accent: 0xe2c08a },  // umber
  { color: 0x6a7a4a, accent: 0xc8a97e },  // moss
  { color: 0x7a5a7a, accent: 0xd1a05a },  // mauve
];
function paletteFor(id) { return PALETTE[(id - 1) % PALETTE.length]; }

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

// Compute weapon tip world position from aim vector and player facing.
// Aim vector in -1..1; tip extends from shoulder along forward + lateral + vertical.
function computeWeaponTip(aim, pos, yaw, length, out = new THREE.Vector3()) {
  // Player forward (XZ): (-sin(yaw), 0, -cos(yaw)). Right: (cos(yaw), 0, -sin(yaw)).
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  const rx =  Math.cos(yaw), rz = -Math.sin(yaw);

  // Build tip-offset direction in world.
  const lat = Math.max(-1, Math.min(1, aim.x));
  const ver = Math.max(-1, Math.min(1, aim.y));
  // Forward component: full when neutral, reduces as we swing wide.
  const fwd = Math.max(0.25, 1 - Math.min(1, Math.hypot(lat, ver) * 0.6));

  let dx = rx * lat + fx * fwd;
  let dy = ver * 0.85 + 0.18;          // bias up slightly
  let dz = rz * lat + fz * fwd;
  // Normalize for unit direction.
  const m = Math.hypot(dx, dy, dz) || 1;
  dx /= m; dy /= m; dz /= m;

  shoulderWorld(pos, yaw, tmpV);
  out.set(tmpV.x + dx * length, tmpV.y + dy * length, tmpV.z + dz * length);
  return out;
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
  state.weaponKey = m.you?.weaponKey ?? state.weaponKey;
  // Set initial camera so screen-up = toward arena center.
  if (m.you?.spawnPos) {
    state.cameraYaw = Math.atan2(m.you.spawnPos.x, m.you.spawnPos.z); // points camera toward (0,0)
  }
  // Rebuild scene with arena info.
  scene = buildScene().scene;
  // Build local rig with chosen weapon.
  const pal = paletteFor(m.id);
  state.rig = buildCharacter({ ...pal, isLocal: true, weaponKey: state.weaponKey });
  scene.add(state.rig.root);
  for (const r of state.remotes.values()) scene.add(r.rig.root);
  HUD.setHp(state.local.hp, RUNTIME.player.hp);
  HUD.log(`welcome to the yard — ${state.weaponKey}`);
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
      HUD.setHp(p.hp, RUNTIME.player.hp);
      HUD.setStamina(p.stamina ?? 100, RUNTIME.player.stamina ?? 100);
      HUD.setDead(!p.alive);
      // Hard-snap on respawn so we don't lerp through walls back into the world.
      if (!wasAlive && p.alive) {
        state.local.pos.set(p.pos.x, p.pos.y, p.pos.z);
        state.local.vel.set(0, 0, 0);
        // Restore helmet on the local rig if it was hidden by a previous head-kill.
        if (state.rig?.parts?.helm) state.rig.parts.helm.visible = true;
      }
      continue;
    }
    let r = state.remotes.get(p.id);
    if (!r || r.weaponKey !== p.weaponKey) {
      if (r) { scene.remove(r.rig.root); }
      const pal = paletteFor(p.id);
      const rig = buildCharacter({ ...pal, weaponKey: p.weaponKey || "arming" });
      scene.add(rig.root);
      r = { rig, buf: [], hp: p.hp, name: p.name, score: 0, deaths: 0,
            weaponKey: p.weaponKey || "arming", lastPos: { ...p.pos }, invulnMs: 0 };
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
    r.stamina = p.stamina ?? 100;
    // Restore detached helm on remote respawn.
    if (!wasAliveR && p.alive && r.rig?.parts?.helm) r.rig.parts.helm.visible = true;
    if (r.buf.length > 30) r.buf.shift();
    r.hp = p.hp;
    r.alive = p.alive;
    r.name = p.name;
    r.score = p.score;
    r.deaths = p.deaths;
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
  if (m.to   === state.myId && m.kill) {
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

net.on("clash", (m) => {
  SFX.clash(computePan(m.at));
  spark(scene, m.at, 0.35, 0xfff0a0);
  if (m.a === state.myId || m.b === state.myId) {
    state.shake.mag = Math.max(state.shake.mag, 0.18);
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
    state.rig = buildCharacter({ ...pal, isLocal: true, weaponKey: m.weapon });
    scene.add(state.rig.root);
    HUD.killFeed(`picked up ${m.weapon}`);
  } else {
    const r = state.remotes.get(m.id);
    if (r) {
      scene.remove(r.rig.root);
      const pal = paletteFor(m.id);
      r.rig = buildCharacter({ ...pal, weaponKey: m.weapon });
      scene.add(r.rig.root);
      r.weaponKey = m.weapon;
    }
  }
  spark(scene, m.at, 0.3, 0x9adfff);
  SFX.click();
});

net.on("matchEnd", (m) => {
  const winName = m.winner === state.myId ? "you" : (state.remotes.get(m.winner)?.name ?? `#${m.winner}`);
  HUD.showBanner(`<div>ROUND ${m.round} · ${escapeHtml(winName)} wins ${m.score}-?</div>
    <div style="font-size:.85rem; opacity:.7; margin-top:.4rem;">next round in ${(CLIENT_MATCH_INTERMISSION_MS/1000)|0}s</div>`);
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
net.on("full",  () => HUD.setMenu(true, "arena full — try later"));
net.on("close", () => HUD.setMenu(true, "disconnected"));
net.on("chat",  (m) => HUD.log(`${m.name}: ${m.text}`));

function nameFor(id) {
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
    // Determine player yaw from aim direction (camera-relative); fallback to movement.
    // Player yaw: rotate to face aim direction relative to CURRENT camera. Player turns
    // smoothly. Camera independently auto-trails the player (no feedback loop because
    // movement basis above is player-yaw, not camera-yaw).
    // Aim → desired player yaw. aim.y > 0 = mouse at top of screen = player should face
    // camera-forward direction. cameraForward(world) = (-sin camYaw, _, -cos camYaw).
    let desiredYaw = state.local.yaw;
    const aimMag = Math.hypot(inp.aim.x, inp.aim.y);
    if (aimMag > 0.18) {
      const cR_x =  Math.cos(state.cameraYaw), cR_z = -Math.sin(state.cameraYaw);  // camera right (X,Z)
      const cF_x = -Math.sin(state.cameraYaw), cF_z = -Math.cos(state.cameraYaw);  // camera forward
      const wx = inp.aim.x * cR_x + inp.aim.y * cF_x;
      const wz = inp.aim.x * cR_z + inp.aim.y * cF_z;
      desiredYaw = Math.atan2(-wx, -wz);
    }
    state.local.yaw = lerpAngle(state.local.yaw, desiredYaw, Math.min(1, dt * 14));

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

    // Compute target weapon tip from aim, then lerp the actual tip toward it with
    // mass-dependent rate (heavier weapons lag more — that's the "weight" feel).
    state.weaponTipPrev.copy(state.weaponTipWorld);
    computeWeaponTip(inp.aim, state.local.pos, state.local.yaw, RUNTIME.weapon.length, state.weaponTipTarget);
    const wMass = RUNTIME.weapon.mass || 1.0;
    // Higher mass → slower convergence. Base 22 / mass.
    const k = Math.min(1, dt * (22 / wMass));
    state.weaponTipWorld.lerp(state.weaponTipTarget, k);
    state.weaponTipVel.subVectors(state.weaponTipWorld, state.weaponTipPrev).divideScalar(Math.max(dt, 1 / 240));

    // Pose rig.
    poseRig(state.rig, state.local.pos, state.local.yaw, state.weaponTipWorld);
    const mvSpeed = Math.hypot(mvWX, mvWZ) * speed;
    // Decompose tip velocity into player-local axes for body-lean animation.
    const cy = Math.cos(-state.local.yaw), sy = Math.sin(-state.local.yaw);
    const swingLat =  cy * state.weaponTipVel.x + sy * state.weaponTipVel.z;
    const swingFwd = -sy * state.weaponTipVel.x + cy * state.weaponTipVel.z;
    state.rig.animate(dt, { mvSpeed, swinging: state.weaponTipVel.length() > 4, blocking: !!inp.block, alive: state.local.alive, swingLat, swingFwd, crippled: (state.local.crippleMsLeft || 0) > 0 });
    state.rig.setInvuln((state.local.invulnMs || 0) > 0, performance.now() / 1000);
    state.rig.pushTrail(state.weaponTipWorld, state.weaponTipVel.length());

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
      weaponTip: { x: state.weaponTipWorld.x, y: state.weaponTipWorld.y, z: state.weaponTipWorld.z },
    });
  }

  // Interpolate remotes.
  const renderTime = performance.now() - CLIENT.INTERP_DELAY_MS;
  for (const r of state.remotes.values()) {
    interpolateRemote(r, renderTime);
  }

  // Camera auto-trails the player. Manual drag (middle/right mouse, mobile ◄►)
  // adds an OFFSET that decays back to behind-player, so dragging is a temporary peek.
  state.cameraYawOffset = (state.cameraYawOffset || 0) + (inp.cameraYawDelta || 0);
  // Decay offset back to 0 over ~1.2s.
  state.cameraYawOffset *= Math.exp(-dt * 0.8);
  if (inp.cameraPitchDelta) state.cameraPitch += inp.cameraPitchDelta;
  state.cameraPitch = Math.max(0.05, Math.min(1.2, state.cameraPitch));
  state.cameraDist = clamp(state.cameraDist + inp.zoomDelta, 2.5, 9);
  // Auto-orient camera behind the player. With our convention forward=(-sin,_,-cos),
  // camera offset (sin*d,_,cos*d) at cameraYaw=playerYaw puts camera on the OPPOSITE
  // side from forward → behind the player.
  const camTargetYaw = state.local.yaw + state.cameraYawOffset;
  state.cameraYaw = lerpAngle(state.cameraYaw, camTargetYaw, Math.min(1, dt * 4.5));

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

  HUD.setStance(stanceLabel(inp));
  updateNameplates();
  tickFallingProps(dt);

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
  r.rig.animate(1 / 60, { mvSpeed, swinging: false, blocking: false, alive: !!r.alive, crippled: (r.crippleMsLeft || 0) > 0 });
  r.rig.setInvuln((r.invulnMs || 0) > 0, performance.now() / 1000);
  // Estimate tip speed from snap delta to drive trail.
  const tipDx = b.weaponTip.x - a.weaponTip.x;
  const tipDy = b.weaponTip.y - a.weaponTip.y;
  const tipDz = b.weaponTip.z - a.weaponTip.z;
  const tipSpd = Math.hypot(tipDx, tipDy, tipDz) / Math.max(0.001, snapDtMs / 1000);
  r.rig.pushTrail(tipV, tipSpd);

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
    div.querySelector(".name").textContent = r.name + " · " + (r.weaponKey || "");
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

// Detach helmet visual from a victim. Spawn a temporary mesh that falls.
const fallingProps = [];
function detachHelmet(victimId, at) {
  let rig = victimId === state.myId ? state.rig : state.remotes.get(victimId)?.rig;
  if (!rig) return;
  const helm = rig.parts?.helm;
  if (!helm || !helm.parent) return;
  // Convert helm world transform.
  const wp = new THREE.Vector3();
  helm.getWorldPosition(wp);
  // Detach: new mesh in scene with same geometry/material, simple physics velocity.
  const m = new THREE.Mesh(helm.geometry, helm.material.clone());
  m.position.copy(wp);
  scene.add(m);
  // Hide original on the rig so it looks like the helm flew off.
  helm.visible = false;
  fallingProps.push({
    mesh: m, vel: new THREE.Vector3(
      (Math.random() - 0.5) * 3,
      4 + Math.random() * 2,
      (Math.random() - 0.5) * 3,
    ),
    angVel: new THREE.Vector3(Math.random()*6-3, Math.random()*6-3, Math.random()*6-3),
    life: 0,
    maxLife: 8,
    rig,                         // restore helm.visible when prop dies (on respawn)
  });
}
function tickFallingProps(dt) {
  for (let i = fallingProps.length - 1; i >= 0; i--) {
    const p = fallingProps[i];
    p.life += dt;
    p.mesh.position.x += p.vel.x * dt;
    p.mesh.position.y += p.vel.y * dt;
    p.mesh.position.z += p.vel.z * dt;
    p.vel.y += -18 * dt;
    if (p.mesh.position.y < 0.05) {
      p.mesh.position.y = 0.05;
      p.vel.y = 0; p.vel.x *= 0.5; p.vel.z *= 0.5;
      p.angVel.multiplyScalar(0.6);
    }
    p.mesh.rotation.x += p.angVel.x * dt;
    p.mesh.rotation.y += p.angVel.y * dt;
    p.mesh.rotation.z += p.angVel.z * dt;
    if (p.life >= p.maxLife) {
      // Restore helm visibility on the rig (in case rig still alive — respawned).
      const helm = p.rig?.parts?.helm;
      if (helm) helm.visible = true;
      scene.remove(p.mesh);
      fallingProps.splice(i, 1);
    }
  }
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
  if (inp.block) return "— guard —";
  const m = Math.hypot(inp.aim.x, inp.aim.y);
  if (m > 0.85) return "— full extension —";
  if (m > 0.45) return "— ready —";
  return "— at rest —";
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
  arming:    "Arming sword — balanced one-hand. Quick, reliable. ~1.1m, ~1.1kg.",
  longsword: "Longsword — two-hand reach, heavier swings, big damage. ~1.3m, ~1.5kg.",
  mace:      "Mace — short, blunt, brutal. Ignores some block reduction. ~0.8m, ~1.4kg.",
  spear:     "Spear — longest reach. Bonus damage on thrust motions. ~2.1m.",
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

// Career stats display.
const careerEl = document.getElementById("career");
if (careerEl) careerEl.textContent = "career · " + statsHtml();

// ---- Settings panel ----
function loadSettings() {
  try { return JSON.parse(localStorage.getItem("ironyard.settings") || "{}"); }
  catch { return {}; }
}
function saveSettings(s) { try { localStorage.setItem("ironyard.settings", JSON.stringify(s)); } catch {} }

const SETTINGS = Object.assign({
  volume: 55, fov: 70, sens: 100, camdist: 4.2,
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
  const name = nameInput.value.trim() || autoName();
  localStorage.setItem("ironyard.name", name);
  const url = serverInput.value.trim() || autoServerUrl();
  HUD.setMenu(true, "connecting…");
  try {
    await net.connect(url);
    net.send({ t: "join", name, weapon: state.weaponKey });
    HUD.setMenu(false);
    requestAnimationFrame(frame);
    setInterval(() => net.sendPing(), 1000);
  } catch (err) {
    HUD.setMenu(true, "could not connect — server offline?");
  }
}
enterBtn.addEventListener("click", play);
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") play(); });

if (params.get("auto")) play();
