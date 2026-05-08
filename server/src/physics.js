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
  constructor(tickHz = 30) {
    this.world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    // Rapier defaults to 1/60s — at 30Hz tick that half-steps physics, making
    // gravity / spring forces effectively half-strength. Match world dt to tick rate.
    this.world.timestep = 1 / tickHz;
    this.eventQueue = new RAPIER.EventQueue(true);
    this.swords = new Map();         // playerId -> { body, collider, weaponMass, length }
    this.bodies = new Map();         // playerId -> { body, collider }
    this.torsos = new Map();         // playerId -> { body, joint } — active ragdoll torso
    this.heads  = new Map();         // playerId -> { body, joint } — head jointed to torso
    this.props  = [];                // dynamic arena props (barrels): { body }
    this.colliderToPlayerSword = new Map();  // colliderHandle -> playerId (attacker)
    this.colliderToPlayerBody  = new Map();  // colliderHandle -> playerId (victim)
    this.wallColliders = new Set();          // colliderHandle of static walls/pillars
    // Per-tick contact register: attackerId -> { victimId -> impactSpeed }
    this._contacts = new Map();
    this._wallClashes = [];                   // { id, speed, pos } per sword-vs-wall hit
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
    // Spherical joint pinning torso bottom to the body capsule's top. Body capsule
    // center is at pos.y + 0.9; top is at +0.9 above center. Torso is created at
    // pos.y + 1.10 with bottom anchor at -0.30 → joint at pos.y + 0.80. Match the body
    // anchor to that height by using y=-0.10 in body's local frame (body local y=0 is
    // its own center at pos.y+0.9; -0.10 → pos.y+0.80, matching torso anchor).
    const params = RAPIER.JointData.spherical(
      { x: 0, y: -0.10, z: 0 },      // anchor on body capsule
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
    // Pull rotation back toward identity (upright) using a strong angular spring so the
    // visible torso never tips over during ordinary play.
    const r = t.body.rotation();
    // For small angles, the imaginary part of the quaternion approximates axis*angle/2.
    const ax = -r.x * 60;          // stiffness toward upright
    const ay = -r.y * 60;
    const az = -r.z * 60;
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
    // Weaker than torso so head bobs more freely, but still strong enough that it
    // tracks the body during normal motion.
    const ax = -r.x * 32;
    const ay = -r.y * 32;
    const az = -r.z * 32;
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
    // k = stiffness, d = damping. With timestep 1/30 the explicit-Euler spring is
    // only stable while dt*sqrt(k_code) < ~0.5, so k_code can't be too large. Heavier
    // weapons get a smaller k_code (more lag = more weight feel).
    const k = 380 / wMass;
    const d = 18;
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
    if (!this._clashes) this._clashes = [];
    // Note: clashes are drained by combat each tick; if combat skipped (countdown/intermission)
    // they accumulate. Bound the buffer so it can't grow unbounded.
    if (this._clashes.length > 64) this._clashes.length = 0;
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
      // Sword-vs-wall/pillar — emit clash for SFX (no damage).
      if (sw1 != null && this.wallColliders.has(h2)) this._stampWallClash(sw1);
      if (sw2 != null && this.wallColliders.has(h1)) this._stampWallClash(sw2);
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
  _stampWallClash(swordPid) {
    const sw = this.swords.get(swordPid);
    if (!sw) return;
    const v = sw.body.linvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    if (speed < 4) return;        // ignore gentle bumps
    const t = sw.body.translation();
    this._wallClashes.push({ id: swordPid, speed, pos: { x: t.x, y: t.y, z: t.z } });
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

  // Static colliders for walls + pillars so swords clack against them.
  // walls: [{ x, z, sx, sz }] center + half extents in XZ. wallH = full height.
  // pillars: [{ x, z, hx, hz }] center + half extents.
  spawnArenaStatics({ size, wallH, pillars }) {
    const halfS = size / 2;
    const wallThick = 0.5;
    const wallSpecs = [
      { x: 0, z: -halfS, sx: size + wallThick * 2, sz: wallThick },
      { x: 0, z:  halfS, sx: size + wallThick * 2, sz: wallThick },
      { x: -halfS, z: 0, sx: wallThick, sz: size },
      { x:  halfS, z: 0, sx: wallThick, sz: size },
    ];
    const fixedDesc = RAPIER.RigidBodyDesc.fixed();
    for (const w of wallSpecs) {
      const body = this.world.createRigidBody(fixedDesc);
      const cd = RAPIER.ColliderDesc.cuboid(w.sx / 2, wallH / 2, w.sz / 2)
        .setTranslation(w.x, wallH / 2, w.z)
        .setRestitution(0.15).setFriction(0.6)
        // Walls participate in BODY group so swords (filter BODY|SWORD) collide.
        .setCollisionGroups((0x0001 << 16) | (0x0001 | 0x0002))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const col = this.world.createCollider(cd, body);
      this.wallColliders.add(col.handle);
    }
    for (const p of pillars || []) {
      const body = this.world.createRigidBody(fixedDesc);
      const cd = RAPIER.ColliderDesc.cuboid(p.hx, wallH * 0.45, p.hz)
        .setTranslation(p.x, wallH * 0.45, p.z)
        .setRestitution(0.15).setFriction(0.6)
        .setCollisionGroups((0x0001 << 16) | (0x0001 | 0x0002))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const col = this.world.createCollider(cd, body);
      this.wallColliders.add(col.handle);
    }
  }

  drainWallClashes() {
    const out = this._wallClashes;
    this._wallClashes = [];
    return out;
  }

  spawnArenaProps(positions) {
    for (const p of positions) {
      const radius = 0.45, height = 0.95;
      // Sit barrel on ground: cylinder half-height = 0.475, so center at 0.475 lifts
      // the bottom flush with y=0.
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y + height / 2, p.z)
        .setLinearDamping(0.7).setAngularDamping(0.9);
      const body = this.world.createRigidBody(desc);
      // Reuse GROUP_BODY membership so swords' filter (BODY|SWORD) collides with barrels.
      // Barrels collide with bodies + swords + other barrels.
      const cd = RAPIER.ColliderDesc.cylinder(height / 2, radius)
        .setDensity(80)
        .setFriction(0.95)
        .setCollisionGroups((GROUP_BODY << 16) | (GROUP_BODY | GROUP_SWORD));
      this.world.createCollider(cd, body);
      this.props.push({ body });
    }
  }

  propsState() {
    const out = [];
    for (let i = 0; i < this.props.length; i++) {
      const p = this.props[i];
      const t = p.body.translation();
      const r = p.body.rotation();
      out.push({ pos: { x: t.x, y: t.y, z: t.z }, rot: { x: r.x, y: r.y, z: r.z, w: r.w } });
    }
    return out;
  }

  // Apply an instant impulse to the torso (e.g. on knockdown for visible flop).
  pushTorso(playerId, impulse) {
    const t = this.torsos.get(playerId);
    if (!t) return;
    t.body.applyImpulse(impulse, true);
  }

  // Snap sword body back to a position with zero velocity (e.g. on respawn).
  resetSwordPos(playerId, pos) {
    const sw = this.swords.get(playerId);
    if (!sw) return;
    sw.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    sw.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    sw.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  // Reset torso/head bodies to upright + clear velocities (e.g. on respawn) so the
  // new life starts without inherited wobble.
  resetRagPos(playerId, pos) {
    const t = this.torsos.get(playerId);
    if (t) {
      t.body.setTranslation({ x: pos.x, y: pos.y + 1.10, z: pos.z }, true);
      t.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      t.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      t.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
    const h = this.heads.get(playerId);
    if (h) {
      h.body.setTranslation({ x: pos.x, y: pos.y + 1.55, z: pos.z }, true);
      h.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      h.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      h.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
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
