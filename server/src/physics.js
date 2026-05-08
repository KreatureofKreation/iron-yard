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

// Collision groups: lower 16 bits = membership, upper 16 = filter.
// SWORD bodies hit BODY capsules and other SWORDs. BODY capsules only collide with SWORDs
// (so players don't push each other through walls).
const GROUP_BODY  = 0x0001;
const GROUP_SWORD = 0x0002;
const GROUPS_BODY_COLLIDER  = (GROUP_BODY  << 16) | GROUP_SWORD;
const GROUPS_SWORD_COLLIDER = (GROUP_SWORD << 16) | (GROUP_BODY | GROUP_SWORD);

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
    this.eventQueue = new RAPIER.EventQueue(true);
    this.swords = new Map();         // playerId -> { body, collider, weaponMass, length }
    this.bodies = new Map();         // playerId -> { body, collider }
    this.torsos = new Map();         // playerId -> { body, joint } — active ragdoll torso
    this.heads  = new Map();         // playerId -> { body, joint } — head jointed to torso
    this.colliderToPlayerSword = new Map();  // colliderHandle -> playerId (attacker)
    this.colliderToPlayerBody  = new Map();  // colliderHandle -> playerId (victim)
    // Per-tick contact register: attackerId -> { victimId -> impactSpeed }
    this._contacts = new Map();
  }

  attachBody(playerId, pos) {
    if (this.bodies.has(playerId)) this.detachBody(playerId);
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(pos.x, pos.y + 0.9, pos.z);
    const body = this.world.createRigidBody(desc);
    const cd = RAPIER.ColliderDesc.capsule(0.5, 0.4)
      .setCollisionGroups(GROUPS_BODY_COLLIDER)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(cd, body);
    this.bodies.set(playerId, { body, collider });
    this.colliderToPlayerBody.set(collider.handle, playerId);
    return body;
  }

  detachBody(playerId) {
    const b = this.bodies.get(playerId);
    if (!b) return;
    this.colliderToPlayerBody.delete(b.collider.handle);
    this.world.removeRigidBody(b.body);
    this.bodies.delete(playerId);
  }

  setBodyPos(playerId, pos) {
    const b = this.bodies.get(playerId);
    if (!b) return;
    b.body.setNextKinematicTranslation({ x: pos.x, y: pos.y + 0.9, z: pos.z });
  }

  // Attach a dynamic torso rigid body anchored to the player's kinematic capsule via
  // a spherical joint. Strong restorative motors keep it roughly upright; perturbations
  // (e.g. impulses from sword reactions) cause visible wobble.
  attachTorso(playerId, pos) {
    if (this.torsos.has(playerId)) this.detachTorso(playerId);
    const b = this.bodies.get(playerId);
    if (!b) return null;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y + 1.10, pos.z)
      .setLinearDamping(4.0)
      .setAngularDamping(8.0);
    const torso = this.world.createRigidBody(desc);
    const cd = RAPIER.ColliderDesc.cuboid(0.30, 0.30, 0.18)
      .setDensity(60)
      .setCollisionGroups(0);  // no collision — visual / dynamics only
    this.world.createCollider(cd, torso);
    // Spherical joint pinning torso bottom to the body capsule top.
    const params = RAPIER.JointData.spherical(
      { x: 0, y: 0.5, z: 0 },        // anchor on body capsule (top)
      { x: 0, y: -0.30, z: 0 },      // anchor on torso (bottom)
    );
    const joint = this.world.createImpulseJoint(params, b.body, torso, true);
    this.torsos.set(playerId, { body: torso, joint });
    return torso;
  }

  detachTorso(playerId) {
    const t = this.torsos.get(playerId);
    if (!t) return;
    if (t.joint) this.world.removeImpulseJoint(t.joint, true);
    this.world.removeRigidBody(t.body);
    this.torsos.delete(playerId);
  }

  // Apply a soft restorative torque toward upright + reads current rotation.
  driveTorso(playerId, dt = 1 / 30) {
    const t = this.torsos.get(playerId);
    if (!t) return;
    // Pull rotation back toward identity (upright) using a small angular spring.
    // Rapier exposes body.rotation() as a quaternion (xyzw).
    const r = t.body.rotation();
    // For small angles, the imaginary part of the quaternion approximates axis*angle/2.
    const ax = -r.x * 24;          // stiffness toward upright
    const ay = -r.y * 24;
    const az = -r.z * 24;
    const m = t.body.mass() || 1;
    t.body.applyTorqueImpulse({ x: ax * m * dt, y: ay * m * dt, z: az * m * dt }, true);
  }

  torsoState(playerId) {
    const t = this.torsos.get(playerId);
    if (!t) return null;
    const rot = t.body.rotation();
    return { rot: { x: rot.x, y: rot.y, z: rot.z, w: rot.w } };
  }

  // Head body, spherical-jointed to the torso. Soft torque keeps it upright.
  attachHead(playerId, pos) {
    if (this.heads.has(playerId)) this.detachHead(playerId);
    const torso = this.torsos.get(playerId);
    if (!torso) return null;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y + 1.55, pos.z)
      .setLinearDamping(3.0)
      .setAngularDamping(6.0);
    const head = this.world.createRigidBody(desc);
    const cd = RAPIER.ColliderDesc.ball(0.18)
      .setDensity(40)
      .setCollisionGroups(0);
    this.world.createCollider(cd, head);
    const params = RAPIER.JointData.spherical(
      { x: 0, y: 0.30, z: 0 },        // anchor on torso (top)
      { x: 0, y: -0.18, z: 0 },       // anchor on head (bottom)
    );
    const joint = this.world.createImpulseJoint(params, torso.body, head, true);
    this.heads.set(playerId, { body: head, joint });
    return head;
  }

  detachHead(playerId) {
    const h = this.heads.get(playerId);
    if (!h) return;
    if (h.joint) this.world.removeImpulseJoint(h.joint, true);
    this.world.removeRigidBody(h.body);
    this.heads.delete(playerId);
  }

  driveHead(playerId, dt = 1 / 30) {
    const h = this.heads.get(playerId);
    if (!h) return;
    const r = h.body.rotation();
    // Weaker spring than torso so head bobs more freely.
    const ax = -r.x * 14;
    const ay = -r.y * 14;
    const az = -r.z * 14;
    const m = h.body.mass() || 1;
    h.body.applyTorqueImpulse({ x: ax * m * dt, y: ay * m * dt, z: az * m * dt }, true);
  }

  headState(playerId) {
    const h = this.heads.get(playerId);
    if (!h) return null;
    const r = h.body.rotation();
    return { rot: { x: r.x, y: r.y, z: r.z, w: r.w } };
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
    // Solid (non-sensor) collider with collision groups so swords physically interact
    // with player bodies and other swords. Density tuned so Rapier-computed mass ≈ weaponMass.
    const cd = RAPIER.ColliderDesc.capsule(halfLen, radius)
      .setDensity(weaponMass * 220)
      .setRestitution(0.05)
      .setFriction(0.4)
      .setCollisionGroups(GROUPS_SWORD_COLLIDER)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(cd, body);
    if (process.env.DEBUG_PHYS) {
      console.log(`[phys] sword id=${playerId} mass=${body.mass().toFixed(2)} len=${length}`);
    }
    this.swords.set(playerId, { body, collider, weaponMass, length });
    this.colliderToPlayerSword.set(collider.handle, playerId);
    return body;
  }

  detachSword(playerId) {
    const sw = this.swords.get(playerId);
    if (!sw) return;
    if (sw.collider) this.colliderToPlayerSword.delete(sw.collider.handle);
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
    const impX = ax * im, impY = ay * im, impZ = az * im;
    sw.body.applyImpulse({ x: impX, y: impY, z: impZ }, true);
    // Newton's third: equal-and-opposite reaction on the torso (active ragdoll feel).
    // Applied at the wrist offset so it imparts torque (twist) on the torso.
    const torso = this.torsos.get(playerId);
    if (torso) {
      const tt = torso.body.translation();
      // Apply at sword grip (~halfway between sword pos and torso, slightly forward).
      const gx = (t.x + tt.x) * 0.5;
      const gy = (t.y + tt.y) * 0.5;
      const gz = (t.z + tt.z) * 0.5;
      torso.body.applyImpulseAtPoint(
        { x: -impX * 0.45, y: -impY * 0.45, z: -impZ * 0.45 },
        { x: gx, y: gy, z: gz },
        true,
      );
    }
  }

  // Steps the world and drains collision-start events into a per-tick contact register.
  // After step(): call drainContacts() to consume {attackerId, victimId, impactSpeed}.
  step() {
    this._contacts.clear();
    this.world.step(this.eventQueue);
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      // Identify which side is sword and which is body (or sword vs sword).
      const sw1 = this.colliderToPlayerSword.get(h1);
      const sw2 = this.colliderToPlayerSword.get(h2);
      const bd1 = this.colliderToPlayerBody.get(h1);
      const bd2 = this.colliderToPlayerBody.get(h2);

      if (sw1 != null && bd2 != null && sw1 !== bd2) this._stampContact(sw1, bd2);
      if (sw2 != null && bd1 != null && sw2 !== bd1) this._stampContact(sw2, bd1);
      if (sw1 != null && sw2 != null && sw1 !== sw2) {
        // Sword-vs-sword clash. Impulse exchange handled by Rapier; we still surface event.
        this._stampClash(sw1, sw2);
      }
    });
  }

  _stampContact(attackerId, victimId) {
    const sw = this.swords.get(attackerId);
    if (!sw) return;
    const v = sw.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    let m = this._contacts.get(attackerId);
    if (!m) { m = new Map(); this._contacts.set(attackerId, m); }
    const prev = m.get(victimId) || 0;
    if (speed > prev) m.set(victimId, speed);
  }
  _stampClash(a, b) {
    const sa = this.swords.get(a), sb = this.swords.get(b);
    if (!sa || !sb) return;
    const va = sa.body.linvel(), vb = sb.body.linvel();
    const sp = Math.hypot(va.x - vb.x, va.y - vb.y, va.z - vb.z);
    if (!this._clashes) this._clashes = [];
    this._clashes.push({ a, b, speed: sp });
  }
  drainContacts() {
    const out = [];
    for (const [attackerId, vmap] of this._contacts) {
      for (const [victimId, speed] of vmap) out.push({ attackerId, victimId, speed });
    }
    return out;
  }
  drainPhysicsClashes() {
    const out = this._clashes || [];
    this._clashes = [];
    return out;
  }

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

  // Toggle gravity on a sword. Used to "drop" the weapon (e.g. while stunned).
  setSwordGravity(playerId, on) {
    const sw = this.swords.get(playerId);
    if (!sw) return;
    sw.body.setGravityScale(on ? 1 : 0, true);
  }

  // Snap sword body back to a position with zero velocity (e.g. on respawn).
  resetSwordPos(playerId, pos) {
    const sw = this.swords.get(playerId);
    if (!sw) return;
    sw.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    sw.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    sw.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
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
