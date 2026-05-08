// Client-side ragdoll using Rapier3D. Activated on death — replaces the kinematic rig
// with a physics-driven set of rigid bodies + joints, then simulates a fall.
//
// Server stays authoritative for game state. Ragdolls are pure visual flavor.
//
// Usage:
//   await initRapier();                      // once at app start
//   const rd = createRagdoll(scene, position, yaw, weaponKey, impulse);
//   ...each frame:  rapierStep(dt);          // step world
//                   for (rd of activeRagdolls) rd.sync();
//   when done:      rd.destroy();

import * as THREE from "three";
import RAPIER from "@dimforge/rapier3d-compat";

let world = null;
let rapierReady = false;
const activeRagdolls = [];

export async function initRapier(gravity = -18) {
  if (rapierReady) return;
  await RAPIER.init();
  world = new RAPIER.World({ x: 0, y: gravity, z: 0 });
  // Ground plane (matches the arena floor at y=0).
  const groundDesc = RAPIER.RigidBodyDesc.fixed();
  const ground = world.createRigidBody(groundDesc);
  world.createCollider(RAPIER.ColliderDesc.cuboid(50, 0.05, 50).setTranslation(0, -0.05, 0), ground);
  rapierReady = true;
}

export function rapierReady_() { return rapierReady; }
export function rapierStep(dt) {
  if (!rapierReady) return;
  // Rapier prefers a fixed substep; we clamp dt to keep stable.
  const sub = Math.max(1, Math.ceil(dt / (1 / 60)));
  const stepDt = dt / sub;
  world.timestep = stepDt;        // CRITICAL: world.step() ignores dt arg, uses world.timestep
  for (let i = 0; i < sub; i++) world.step();
  for (const rd of activeRagdolls) rd._sync();
}

// Lightweight visual proportions so the ragdoll roughly matches our rig.
const PROPS = {
  height: 1.8, radius: 0.4,
};

function makeBoxBody(world, hx, hy, hz, x, y, z, density = 1.5) {
  const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z);
  desc.setLinearDamping(0.4); desc.setAngularDamping(0.6);
  const body = world.createRigidBody(desc);
  const cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(density).setRestitution(0.05).setFriction(0.9);
  world.createCollider(cd, body);
  return body;
}

function joinSpherical(world, a, b, ax, ay, az, bx, by, bz) {
  const params = RAPIER.JointData.spherical({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz });
  return world.createImpulseJoint(params, a, b, true);
}

function joinFixed(world, a, b, ax, ay, az, bx, by, bz) {
  const params = RAPIER.JointData.fixed(
    { x: ax, y: ay, z: az }, { x: 0, y: 0, z: 0, w: 1 },
    { x: bx, y: by, z: bz }, { x: 0, y: 0, z: 0, w: 1 },
  );
  return world.createImpulseJoint(params, a, b, true);
}

// Build a ragdoll at world position+yaw. Optionally apply a directional impulse on the
// torso to simulate the strike that killed the player.
//
// 11-body ragdoll: head, torso, hips + upper/forearm × 2 + thigh/shin × 2.
// Matches the multi-bone proportions used by buildCharacter() so dropped corpses look
// the same as living players (Half-Sword-style limbs).
export function createRagdoll(scene, pos, yaw = 0, color = 0x9aa0a8, accent = 0xc8a97e, impulse = null) {
  if (!rapierReady) return null;

  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

  const skinMat   = new THREE.MeshStandardMaterial({ color: 0xc8997a, roughness: 0.9 });
  const plateMat  = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.55 });
  const mailMat   = new THREE.MeshStandardMaterial({ color: 0x4a4a52, roughness: 0.55, metalness: 0.7 });
  const leatherMat= new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95 });
  const cloakMat  = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.85 });

  const root = new THREE.Group();
  scene.add(root);

  // Body half-extents and anchor offsets (mirror buildCharacter's segment lengths).
  const TORSO   = { hx: 0.30, hy: 0.16, hz: 0.18 };  // chest+abdomen merged
  const HIPS    = { hx: 0.26, hy: 0.09, hz: 0.18 };
  const HEAD    = { hx: 0.18, hy: 0.20, hz: 0.18 };
  const UPARM   = { hx: 0.08, hy: 0.18, hz: 0.08 };
  const FOREARM = { hx: 0.08, hy: 0.20, hz: 0.08 };
  const THIGH   = { hx: 0.10, hy: 0.20, hz: 0.10 };
  const SHIN    = { hx: 0.09, hy: 0.18, hz: 0.09 };

  const px = pos.x, pz = pos.z, py = pos.y;
  // Y centers (spawn upright in T-pose). Will be yaw-rotated below.
  const yHips     = py + 0.84;
  const yTorso    = py + 1.18;
  const yHead     = py + 1.62;
  const yShoulder = py + 1.40;
  const yUparm    = yShoulder - UPARM.hy;
  const yForearm  = yUparm - UPARM.hy - FOREARM.hy;
  const yHip      = yHips - HIPS.hy;
  const yThigh    = yHip - THIGH.hy;
  const yShin     = yThigh - THIGH.hy - SHIN.hy;

  const torsoBody  = makeBoxBody(world, TORSO.hx, TORSO.hy, TORSO.hz, px, yTorso, pz);
  const hipsBody   = makeBoxBody(world, HIPS.hx,  HIPS.hy,  HIPS.hz,  px, yHips, pz);
  const headBody   = makeBoxBody(world, HEAD.hx,  HEAD.hy,  HEAD.hz,  px, yHead, pz, 1.2);
  const upArmLBody = makeBoxBody(world, UPARM.hx, UPARM.hy, UPARM.hz, px - 0.40, yUparm, pz);
  const upArmRBody = makeBoxBody(world, UPARM.hx, UPARM.hy, UPARM.hz, px + 0.40, yUparm, pz);
  const forArmLBody= makeBoxBody(world, FOREARM.hx, FOREARM.hy, FOREARM.hz, px - 0.40, yForearm, pz);
  const forArmRBody= makeBoxBody(world, FOREARM.hx, FOREARM.hy, FOREARM.hz, px + 0.40, yForearm, pz);
  const thighLBody = makeBoxBody(world, THIGH.hx, THIGH.hy, THIGH.hz,  px - 0.16, yThigh, pz);
  const thighRBody = makeBoxBody(world, THIGH.hx, THIGH.hy, THIGH.hz,  px + 0.16, yThigh, pz);
  const shinLBody  = makeBoxBody(world, SHIN.hx,  SHIN.hy,  SHIN.hz,   px - 0.16, yShin, pz);
  const shinRBody  = makeBoxBody(world, SHIN.hx,  SHIN.hy,  SHIN.hz,   px + 0.16, yShin, pz);

  // Joints — spherical for all (cheap, no twist limits).
  // Each anchor is in the local frame of its body; offsets are signed half-extents.
  joinSpherical(world, torsoBody, hipsBody,  0, -TORSO.hy, 0,    0,  HIPS.hy, 0);
  joinSpherical(world, torsoBody, headBody,  0,  TORSO.hy, 0,    0, -HEAD.hy, 0);
  joinSpherical(world, torsoBody, upArmLBody, -TORSO.hx - UPARM.hx, TORSO.hy * 0.4, 0,  0,  UPARM.hy, 0);
  joinSpherical(world, torsoBody, upArmRBody,  TORSO.hx + UPARM.hx, TORSO.hy * 0.4, 0,  0,  UPARM.hy, 0);
  joinSpherical(world, upArmLBody, forArmLBody, 0, -UPARM.hy, 0,  0,  FOREARM.hy, 0);
  joinSpherical(world, upArmRBody, forArmRBody, 0, -UPARM.hy, 0,  0,  FOREARM.hy, 0);
  joinSpherical(world, hipsBody,  thighLBody, -0.16, -HIPS.hy, 0,  0,  THIGH.hy, 0);
  joinSpherical(world, hipsBody,  thighRBody,  0.16, -HIPS.hy, 0,  0,  THIGH.hy, 0);
  joinSpherical(world, thighLBody, shinLBody,  0, -THIGH.hy, 0,  0,  SHIN.hy, 0);
  joinSpherical(world, thighRBody, shinRBody,  0, -THIGH.hy, 0,  0,  SHIN.hy, 0);

  const allBodies = [
    torsoBody, hipsBody, headBody,
    upArmLBody, upArmRBody, forArmLBody, forArmRBody,
    thighLBody, thighRBody, shinLBody, shinRBody,
  ];

  // Initial yaw — rotate every body around player center.
  for (const body of allBodies) {
    const t = body.translation();
    const local = new THREE.Vector3(t.x - px, t.y - py, t.z - pz).applyQuaternion(yawQ);
    body.setTranslation({ x: px + local.x, y: py + local.y, z: pz + local.z }, true);
    body.setRotation({ x: yawQ.x, y: yawQ.y, z: yawQ.z, w: yawQ.w }, true);
  }

  // Visual meshes mirroring each body.
  function box(b, hx, hy, hz, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
    m.castShadow = true;
    root.add(m);
    return { body: b, mesh: m };
  }
  const visuals = [
    box(torsoBody,  TORSO.hx, TORSO.hy, TORSO.hz, plateMat),
    box(hipsBody,   HIPS.hx,  HIPS.hy,  HIPS.hz,  plateMat),
    box(headBody,   HEAD.hx,  HEAD.hy,  HEAD.hz,  skinMat),
    box(upArmLBody, UPARM.hx, UPARM.hy, UPARM.hz, mailMat),
    box(upArmRBody, UPARM.hx, UPARM.hy, UPARM.hz, mailMat),
    box(forArmLBody,FOREARM.hx,FOREARM.hy,FOREARM.hz, plateMat),
    box(forArmRBody,FOREARM.hx,FOREARM.hy,FOREARM.hz, plateMat),
    box(thighLBody, THIGH.hx, THIGH.hy, THIGH.hz, mailMat),
    box(thighRBody, THIGH.hx, THIGH.hy, THIGH.hz, mailMat),
    box(shinLBody,  SHIN.hx,  SHIN.hy,  SHIN.hz,  plateMat),
    box(shinRBody,  SHIN.hx,  SHIN.hy,  SHIN.hz,  plateMat),
  ];

  // Apply incoming impulse to torso (and a smaller one to head) for that "blown-back" feel.
  if (impulse) {
    torsoBody.applyImpulse({ x: impulse.x * 6, y: impulse.y * 6 + 2, z: impulse.z * 6 }, true);
    torsoBody.applyTorqueImpulse({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
    headBody.applyImpulse({ x: impulse.x * 1.5, y: impulse.y * 1.5 + 1, z: impulse.z * 1.5 }, true);
  }

  const rd = {
    root,
    bodies: allBodies,
    expiresAt: performance.now() + 9000,
    _sync() {
      for (const v of visuals) {
        const t = v.body.translation();
        const r = v.body.rotation();
        v.mesh.position.set(t.x, t.y, t.z);
        v.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      }
    },
    destroy() {
      for (const v of visuals) {
        scene.remove(v.mesh);
        v.mesh.geometry.dispose();
      }
      for (const b of this.bodies) world.removeRigidBody(b);
      const i = activeRagdolls.indexOf(this);
      if (i >= 0) activeRagdolls.splice(i, 1);
      scene.remove(this.root);
    },
  };
  rd._sync();
  activeRagdolls.push(rd);
  return rd;
}

export function tickRagdolls(now = performance.now()) {
  for (let i = activeRagdolls.length - 1; i >= 0; i--) {
    const rd = activeRagdolls[i];
    if (now > rd.expiresAt) rd.destroy();
  }
  // Expire physics-driven falling helmets.
  for (let i = activeHelms.length - 1; i >= 0; i--) {
    const h = activeHelms[i];
    if (now > h.expiresAt) {
      try { h.onExpire?.(); } catch {}
      scene_remove(h);
      activeHelms.splice(i, 1);
    } else {
      const t = h.body.translation();
      const r = h.body.rotation();
      h.mesh.position.set(t.x, t.y, t.z);
      h.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }
}

export function clearAllRagdolls() {
  while (activeRagdolls.length) activeRagdolls.pop().destroy();
  while (activeHelms.length) {
    const h = activeHelms.pop();
    try { h.onExpire?.(); } catch {}
    scene_remove(h);
  }
}

// Physics-driven detached helmet. Ball collider approximates the dome; dynamic body
// inherits the impulse from the killing strike so the helm visibly tumbles + rolls
// before settling on the floor. Lasts ~10s before fade-and-cleanup.
const activeHelms = [];
function scene_remove(h) {
  if (h.scene && h.mesh) {
    try { h.scene.remove(h.mesh); } catch {}
  }
  if (h.body) {
    try { world.removeRigidBody(h.body); } catch {}
  }
}
export function spawnFallingHelm(scene, helmMesh, pos, dirImpulse, onExpire) {
  if (!rapierReady) return null;
  const desc = RAPIER.RigidBodyDesc.dynamic()
    .setTranslation(pos.x, pos.y, pos.z)
    .setLinearDamping(0.45)
    .setAngularDamping(0.25);
  const body = world.createRigidBody(desc);
  // Ball collider sized to the helm dome (~radius 0.27).
  const cd = RAPIER.ColliderDesc.ball(0.27)
    .setDensity(3.0)
    .setRestitution(0.45)
    .setFriction(0.55);
  world.createCollider(cd, body);
  scene.add(helmMesh);
  body.applyImpulse({
    x: dirImpulse.x * 4, y: 3 + Math.random() * 2, z: dirImpulse.z * 4,
  }, true);
  body.applyTorqueImpulse({
    x: (Math.random() - 0.5) * 1.2,
    y: (Math.random() - 0.5) * 1.2,
    z: (Math.random() - 0.5) * 1.2,
  }, true);
  const entry = { body, mesh: helmMesh, scene, expiresAt: performance.now() + 10000, onExpire };
  activeHelms.push(entry);
  return entry;
}

// Spawn a few static-ish barrels at arena edges. They live in the same Rapier world,
// so player-controlled "kick" can apply impulses.
const arenaProps = [];
export function spawnArenaProps(scene, points) {
  if (!rapierReady) return;
  for (const p of points) {
    const radius = 0.45, height = 0.95;
    const desc = RAPIER.RigidBodyDesc.dynamic().setTranslation(p.x, p.y + height / 2 + 0.2, p.z);
    desc.setLinearDamping(0.7); desc.setAngularDamping(0.9);
    const body = world.createRigidBody(desc);
    const cd = RAPIER.ColliderDesc.cylinder(height / 2, radius).setDensity(2.5).setFriction(0.95);
    world.createCollider(cd, body);

    const mat = new THREE.MeshStandardMaterial({ color: 0x6a4a30, roughness: 0.9 });
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 });
    const grp = new THREE.Group();
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
    arenaProps.push({ body, mesh: grp });
  }
}

export function applyKickToProps(playerPos, playerVel) {
  if (!rapierReady) return;
  const speedSq = playerVel.x * playerVel.x + playerVel.z * playerVel.z;
  if (speedSq < 4) return;  // need to be moving meaningfully
  for (const p of arenaProps) {
    const t = p.body.translation();
    const dx = t.x - playerPos.x, dz = t.z - playerPos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > 1.3 * 1.3) continue;
    const inv = 1 / Math.max(0.1, Math.sqrt(d2));
    const force = Math.min(1, speedSq / 25) * 8;
    p.body.applyImpulse({ x: dx * inv * force, y: 0, z: dz * inv * force }, true);
  }
}

export function syncProps() {
  for (const p of arenaProps) {
    const t = p.body.translation();
    const r = p.body.rotation();
    p.mesh.position.set(t.x, t.y, t.z);
    p.mesh.quaternion.set(r.x, r.y, r.z, r.w);
  }
}

export function clearArenaProps(scene) {
  for (const p of arenaProps) {
    scene.remove(p.mesh);
    world.removeRigidBody(p.body);
  }
  arenaProps.length = 0;
}
