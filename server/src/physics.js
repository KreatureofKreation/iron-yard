// Server-side Rapier physics. Each player's weapon is a real rigid body driven by a
// spring-damper force toward the aim target. Tip velocity therefore comes from real
// dynamics — heavier weapons accelerate slowly and overshoot, light ones snap.
//
// Phase A (this pass): sensor-only sword body (no contact response). Existing
// segment-vs-capsule combat keeps doing hit detection but reads physics-driven
// tip pos / vel, so impact velocity (and thus damage) reflects real momentum.
//
// Phase B (later): switch to collision-event-driven damage with full body capsules.

import RAPIER from "@dimforge/rapier3d-compat";

let initialized = false;

export async function initRapier() {
  if (initialized) return;
  await RAPIER.init();
  initialized = true;
}

export function isRapierReady() { return initialized; }

export class PhysicsWorld {
  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    this.swords = new Map();   // playerId -> { body, weaponMass, length }
  }

  attachSword(playerId, weaponMass, length, startPos = { x: 0, y: 1.4, z: 0 }) {
    if (this.swords.has(playerId)) this.detachSword(playerId);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(startPos.x, startPos.y, startPos.z)
      .setLinearDamping(2.0)
      .setAngularDamping(2.0)
      .setGravityScale(0)              // no gravity while held — spring keeps it up
      .setCcdEnabled(true);             // fast swings don't tunnel
    const body = this.world.createRigidBody(desc);
    const radius = 0.05;
    const halfLen = Math.max(0.05, length / 2 - radius);
    // Sensor collider with high density → Rapier-computed body mass roughly matches
    // weaponMass without divide-by-zero issues. Mass scaling for damage/feel is then
    // handled by reading body.mass() in driveSword.
    const cd = RAPIER.ColliderDesc.capsule(halfLen, radius)
      .setDensity(weaponMass * 220)        // tuned so body.mass() ≈ weaponMass
      .setSensor(true);
    this.world.createCollider(cd, body);
    if (process.env.DEBUG_PHYS) {
      console.log(`[phys] sword id=${playerId} mass=${body.mass().toFixed(2)} len=${length}`);
    }
    this.swords.set(playerId, { body, weaponMass, length });
    return body;
  }

  detachSword(playerId) {
    const sw = this.swords.get(playerId);
    if (!sw) return;
    this.world.removeRigidBody(sw.body);
    this.swords.delete(playerId);
  }

  // Spring + damper drive. Strong-but-bounded force pulls sword toward target.
  // Spring + damper drive. Underdamped so the sword overshoots (real swing feel).
  driveSword(playerId, target, dt = 1 / 30) {
    const sw = this.swords.get(playerId);
    if (!sw) return;
    const t = sw.body.translation();
    const v = sw.body.linvel();
    const wMass = sw.weaponMass;
    const bodyMass = sw.body.mass() || wMass;        // Rapier-computed mass
    // k = stiffness, d = damping. Inverse-mass on stiffness so heavier feels heavier.
    // Damping low enough that the tip overshoots toward fast target motion (swing feel).
    const k = 800 / wMass;
    const d = 10;
    const ax = (target.x - t.x) * k - v.x * d;
    const ay = (target.y - t.y) * k - v.y * d;
    const az = (target.z - t.z) * k - v.z * d;
    // Convert (target accel) → impulse for THIS body's actual mass.
    const im = bodyMass * dt;
    sw.body.applyImpulse({ x: ax * im, y: ay * im, z: az * im }, true);
  }

  step() { this.world.step(); }

  swordState(playerId) {
    const sw = this.swords.get(playerId);
    if (!sw) return null;
    const t = sw.body.translation();
    const v = sw.body.linvel();
    return {
      pos: { x: t.x, y: t.y, z: t.z },
      vel: { x: v.x, y: v.y, z: v.z },
      length: sw.length,
    };
  }

  // Replace the body for a weapon-swap. Keeps current position so the swap looks smooth.
  swapWeapon(playerId, newMass, newLength) {
    const sw = this.swords.get(playerId);
    if (!sw) return null;
    const at = sw.body.translation();
    this.detachSword(playerId);
    return this.attachSword(playerId, newMass, newLength, at);
  }
}
