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
export function createRagdoll(scene, pos, yaw = 0, color = 0x9aa0a8, accent = 0xc8a97e, impulse = null) {
  if (!rapierReady) return null;

  const yawQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);

  const skinMat = new THREE.MeshStandardMaterial({ color: 0xc8997a, roughness: 0.9 });
  const armorMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.4 });
  const cloakMat = new THREE.MeshStandardMaterial({ color: accent, roughness: 0.85 });
  const gripMat = new THREE.MeshStandardMaterial({ color: 0x2a1c12, roughness: 0.95 });

  const root = new THREE.Group();
  scene.add(root);

  // Body parts: torso, hips, head, two arms, two legs.
  const px = pos.x, pz = pos.z, py = pos.y;
  const torsoBody = makeBoxBody(world, 0.30, 0.30, 0.18, px, py + 1.10, pz);
  const hipsBody  = makeBoxBody(world, 0.26, 0.10, 0.18, px, py + 0.78, pz);
  const headBody  = makeBoxBody(world, 0.18, 0.20, 0.18, px, py + 1.55, pz, 1.2);
  const armLBody  = makeBoxBody(world, 0.08, 0.22, 0.08, px - 0.40, py + 1.10, pz);
  const armRBody  = makeBoxBody(world, 0.08, 0.22, 0.08, px + 0.40, py + 1.10, pz);
  const legLBody  = makeBoxBody(world, 0.10, 0.30, 0.10, px - 0.16, py + 0.42, pz);
  const legRBody  = makeBoxBody(world, 0.10, 0.30, 0.10, px + 0.16, py + 0.42, pz);

  // Joints (spherical = no twist limits — quick and dirty).
  joinSpherical(world, torsoBody, hipsBody, 0, -0.32, 0, 0, 0.10, 0);
  joinSpherical(world, torsoBody, headBody, 0,  0.30, 0, 0, -0.20, 0);
  joinSpherical(world, torsoBody, armLBody,-0.35, 0.20, 0, 0,  0.20, 0);
  joinSpherical(world, torsoBody, armRBody, 0.35, 0.20, 0, 0,  0.20, 0);
  joinSpherical(world, hipsBody,  legLBody,-0.16,-0.10, 0, 0,  0.30, 0);
  joinSpherical(world, hipsBody,  legRBody, 0.16,-0.10, 0, 0,  0.30, 0);

  // Initial yaw: rotate every body around player center.
  for (const body of [torsoBody, hipsBody, headBody, armLBody, armRBody, legLBody, legRBody]) {
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
    box(torsoBody, 0.30, 0.30, 0.18, armorMat),
    box(hipsBody,  0.26, 0.10, 0.18, armorMat),
    box(headBody,  0.18, 0.20, 0.18, skinMat),
    box(armLBody,  0.08, 0.22, 0.08, armorMat),
    box(armRBody,  0.08, 0.22, 0.08, armorMat),
    box(legLBody,  0.10, 0.30, 0.10, gripMat),
    box(legRBody,  0.10, 0.30, 0.10, gripMat),
  ];

  // Apply incoming impulse to torso (and a smaller one to head) for that "blown-back" feel.
  if (impulse) {
    torsoBody.applyImpulse({ x: impulse.x * 6, y: impulse.y * 6 + 2, z: impulse.z * 6 }, true);
    torsoBody.applyTorqueImpulse({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 4 }, true);
    headBody.applyImpulse({ x: impulse.x * 1.5, y: impulse.y * 1.5 + 1, z: impulse.z * 1.5 }, true);
  }

  const rd = {
    root,
    bodies: [torsoBody, hipsBody, headBody, armLBody, armRBody, legLBody, legRBody],
    expiresAt: performance.now() + 9000,    // cleaned up after a while
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
}

export function clearAllRagdolls() {
  while (activeRagdolls.length) activeRagdolls.pop().destroy();
}
