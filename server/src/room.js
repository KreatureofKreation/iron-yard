import { CONFIG } from "./config.js";
import { spawnPoints, obstacles, weaponRacks } from "./arena.js";
import { makePlayer, applyInput, maybeRespawn, weaponOf } from "./player.js";
import { resolveHits } from "./combat.js";
import { botInput, pickBotName, pickBotWeapon, botDifficultyTuning } from "./bot.js";
import { PhysicsWorld } from "./physics.js";

let BOT_TARGET = Number(process.env.BOT_COUNT ?? 1);
let BOT_DIFFICULTY = (process.env.BOT_DIFFICULTY || "medium").toLowerCase();

export class Room {
  constructor() {
    this.players = new Map();
    this.spectators = new Set();
    this.physics = new PhysicsWorld(CONFIG.TICK_HZ);
    this.physics.spawnArenaStatics({
      size: CONFIG.ARENA.size,
      wallH: CONFIG.ARENA.wallH,
      pillars: obstacles(),
    });
    this.physics.spawnArenaProps([
      { x: -10, y: 0, z: -10 }, { x:  10, y: 0, z: -10 },
      { x: -10, y: 0, z:  10 }, { x:  10, y: 0, z:  10 },
      { x:   0, y: 0, z: -12 }, { x:   0, y: 0, z:  12 },
    ]);
    this.tick = 0;
    this.lastTickMs = Date.now();
    this.spawns = spawnPoints();
    this.spawnIdx = 0;
    this.pendingHits = [];
    // Match state.
    this.matchPhase = "countdown";       // "countdown" | "playing" | "intermission"
    this.phaseUntil = Date.now() + CONFIG.MATCH.countdownMs;
    this.roundEndsAt = 0;
    this.winnerId = null;
    this.winReason = null;               // "score" | "timeout" | null
    this.roundIndex = 1;
  }

  isFull() {
    // Zombies (disconnected players awaiting reconnect) still count toward cap so
    // their slot is preserved.
    return this.players.size >= CONFIG.MAX_PLAYERS;
  }

  // Find a zombie player matching a session. Returns the player or null.
  findZombieBySession(sessionId) {
    if (!sessionId) return null;
    const now = Date.now();
    for (const p of this.players.values()) {
      if (p.zombieUntilMs > now && p.sessionId === sessionId) return p;
    }
    return null;
  }

  nextSpawn() {
    const s = this.spawns[this.spawnIdx % this.spawns.length];
    this.spawnIdx++;
    return s;
  }

  addPlayer(name, socket, weaponKey) {
    const p = makePlayer(name, this.nextSpawn(), weaponKey);
    p.socket = socket;
    this.players.set(p.id, p);
    this._attachPlayerSword(p);
    this.ensureBots();
    return p;
  }

  _attachPlayerSword(p) {
    const w = weaponOf(p);
    const startTip = { x: p.pos.x, y: p.pos.y + 1.4, z: p.pos.z - 0.3 };
    p.weaponTip = { ...startTip };
    p.weaponTipPrev = { ...startTip };
    this.physics.attachSword(p.id, w.mass, w.length, startTip);
    this.physics.attachBody(p.id, p.pos);
    this.physics.attachTorso(p.id, p.pos);
    this.physics.attachHead(p.id, p.pos);
  }

  removePlayer(id) {
    this.players.delete(id);
    this.physics.detachSword(id);
    this.physics.detachBody(id);
    this.physics.detachTorso(id);
    this.physics.detachHead(id);
    for (const p of this.players.values()) {
      p.lastHitAtMs.delete(id);
      p.parryUntilMs.delete(id);
    }
    this.ensureBots();
  }

  // Soft-disconnect: keep the slot for reconnectGraceMs. Returns true if zombified.
  zombifyPlayer(id) {
    const p = this.players.get(id);
    if (!p || !p.sessionId) return false;
    p.socket = null;
    p.zombieUntilMs = Date.now() + CONFIG.PLAYER.reconnectGraceMs;
    p.pendingInput = null;
    return true;
  }

  // Hard-remove zombies that exceeded grace window.
  reapZombies() {
    const now = Date.now();
    for (const p of [...this.players.values()]) {
      if (p.zombieUntilMs > 0 && p.zombieUntilMs <= now) {
        this.removePlayer(p.id);
      }
    }
  }

  addBot(difficulty = BOT_DIFFICULTY) {
    const name = `[bot] ${pickBotName(this.players)}`;
    const p = makePlayer(name, this.nextSpawn(), pickBotWeapon());
    p.bot = true;
    p.botTuning = botDifficultyTuning(difficulty);
    p.difficulty = difficulty;
    this.players.set(p.id, p);
    this._attachPlayerSword(p);
    return p;
  }

  countHumans() {
    let n = 0;
    for (const p of this.players.values()) if (p.socket) n++;
    return n;
  }
  countBots() {
    let n = 0;
    for (const p of this.players.values()) if (p.bot) n++;
    return n;
  }
  removeOneBot() {
    for (const p of this.players.values()) if (p.bot) { this.players.delete(p.id); return p.id; }
    return null;
  }

  setBotTarget(n) {
    BOT_TARGET = Math.max(0, Math.min(CONFIG.MAX_PLAYERS - 1, n | 0));
    this.ensureBots();
  }
  setBotDifficulty(level) {
    BOT_DIFFICULTY = level;
    // Re-tune existing bots.
    for (const p of this.players.values()) {
      if (p.bot) { p.botTuning = botDifficultyTuning(level); p.difficulty = level; }
    }
  }

  ensureBots() {
    const humans = this.countHumans();
    let bots = this.countBots();
    // 0 humans → no bots (server idle).
    // 1 human → keep BOT_TARGET bots so solo play isn't empty.
    // 2+ humans → kick all bots (humans want to fight each other).
    let desired = 0;
    if (humans === 1) desired = Math.min(BOT_TARGET, CONFIG.MAX_PLAYERS - humans);
    while (bots < desired && this.players.size < CONFIG.MAX_PLAYERS) { this.addBot(); bots++; }
    while (bots > desired) { if (this.removeOneBot() == null) break; bots--; }
  }

  handleInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    // Buffer the most recent input only. Sim runs once per tick — input rate-limit-proof.
    p.pendingInput = input;
  }

  step() {
    const now = Date.now();
    this.lastTickMs = now;
    this.tick++;
    this.reapZombies();

    const dtMs = 1000 / CONFIG.TICK_HZ;
    const dt = dtMs / 1000;
    const frozen = this.matchPhase === "countdown";

    // 1) Resolve each player's input → updates p.pos and stamps the AIM TARGET into
    //    p.weaponTipTarget (we re-route the existing weaponTip field to mean "target").
    for (const p of this.players.values()) {
      let input;
      if (p.bot && p.alive && !frozen) {
        input = botInput(p, this.players, now, weaponRacks());
      } else if (p.pendingInput && !frozen) {
        input = p.pendingInput;
        p.pendingInput = null;
      } else {
        if (p.pendingInput) p.pendingInput = null;
        input = { mv: { x: 0, y: 0 }, yaw: p.yaw, sprint: false, jump: false,
                  blocking: false, swinging: false, weaponTip: p.weaponTip };
      }
      applyInput(p, input, dtMs);
      // After applyInput, p.weaponTip is the (clamped) target from the client/bot.
      p.weaponTipTarget = { x: p.weaponTip.x, y: p.weaponTip.y, z: p.weaponTip.z };
    }

    // 2) Sync each player's kinematic body capsule to their current pos, drive sword,
    //    then step the world. Stunned/disarmed players DROP their sword (gravity on,
    //    no drive). Disarmed players who walk over their own sword pick it up early.
    for (const p of this.players.values()) {
      if (p.zombieUntilMs > now) continue;
      this.physics.setBodyPos(p.id, p.pos);
      const stunned  = now < p.stunUntilMs;
      const dead     = !p.alive;
      let disarmed   = now < p.disarmedUntilMs;
      const knocked  = now < p.knockedDownUntilMs;
      // Early pickup: while disarmed and within 1m of sword, restore.
      // Severed-arm players cannot rearm — their sword stays on the ground for the round.
      if (disarmed && !stunned && !dead && !p.severedArm) {
        const sw = this.physics.swordState(p.id);
        if (sw) {
          const dx = sw.pos.x - p.pos.x, dz = sw.pos.z - p.pos.z;
          if (dx * dx + dz * dz < 1.0) {
            p.disarmedUntilMs = 0;
            disarmed = false;
            this.pendingHits.push({ kind: "pickup", id: p.id, weapon: p.weaponKey, at: { x: sw.pos.x, y: 0, z: sw.pos.z } });
          }
        }
      }
      if (stunned || dead || disarmed || knocked) {
        this.physics.setSwordGravity(p.id, true);
      } else {
        this.physics.setSwordGravity(p.id, false);
        this.physics.driveSword(p.id, p.weaponTipTarget, dt);
      }
      // Restorative torque on torso + head — skip while knocked down so the body
      // physically slumps under gravity and joint constraints (real ragdoll).
      if (!knocked && !dead) {
        this.physics.driveTorso(p.id, dt);
        this.physics.driveHead(p.id, dt);
      }
      // Footstep bob: vertical sinewave impulse to torso when moving on ground.
      const horizSpeed = Math.hypot(p.vel.x, p.vel.z);
      if (!knocked && !dead && p.onGround && horizSpeed > 0.5) {
        const stepHz = 1.5 + horizSpeed * 0.3;
        const phase  = (this.tick * dt * stepHz * Math.PI * 2) + (p.id * 0.7);
        const bob    = Math.sin(phase) * Math.min(1.5, horizSpeed * 0.4);
        this.physics.pushTorso(p.id, { x: 0, y: bob * 0.06, z: 0 });
      }
    }
    this.physics.step();

    // 3) Read back actual sword pos+velocity. Subtract player vel to isolate swing motion.
    //    Detect wind-up→strike commitment via direction reversal at speed.
    for (const p of this.players.values()) {
      const s = this.physics.swordState(p.id);
      if (!s) continue;
      p.weaponTip = s.pos;
      const v = {
        x: s.vel.x - (p.vel.x || 0),
        y: s.vel.y - (p.vel.y || 0),
        z: s.vel.z - (p.vel.z || 0),
      };
      const mag = Math.hypot(v.x, v.y, v.z);
      const lv = p._lastTipVel;
      const lmag = lv ? Math.hypot(lv.x, lv.y, lv.z) : 0;
      if (mag > 6 && lmag > 3) {
        const cosA = (v.x*lv.x + v.y*lv.y + v.z*lv.z) / (mag * lmag);
        if (cosA < -0.5) p.commitStrikeUntilMs = now + 250;
      }
      p._lastTipVel = v;
      p.weaponTipVel = v;
    }

    // Bleed ticks (DOT). Accumulator handles fractional dmg.
    const tickSec = dtMs / 1000;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (now < p.bleedUntilMs && p.bleedDmgPerSec > 0) {
        p.bleedAccum += p.bleedDmgPerSec * tickSec;
        const whole = Math.floor(p.bleedAccum);
        if (whole > 0) {
          p.bleedAccum -= whole;
          p.hp = Math.max(0, p.hp - whole);
          this.pendingHits.push({ kind: "bleed", to: p.id, dmg: whole, at: { x: p.pos.x, y: p.pos.y + 1.2, z: p.pos.z } });
          if (p.hp <= 0) {
            // Bleed-out death — no attribution.
            p.alive = false; p.hp = 0; p.deadAtMs = now; p.deaths++;
            p.killStreak = 0;
            this.pendingHits.push({ kind: "hit", from: 0, to: p.id, dmg: whole, kill: true, zone: "torso", weapon: "bleed",
              at: { x: p.pos.x, y: p.pos.y + 1.0, z: p.pos.z } });
          }
        }
      } else {
        p.bleedDmgPerSec = 0;
        p.bleedAccum = 0;
      }
    }

    // Respawn dead. After respawn, reset sword + torso/head to player's hand area.
    // Bots also re-roll their weapon on respawn for combat variety.
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (maybeRespawn(p, this.nextSpawn(), now)) {
          if (p.bot) {
            const newWeapon = pickBotWeapon();
            if (newWeapon !== p.weaponKey) {
              p.weaponKey = newWeapon;
              const w = weaponOf(p);
              this.physics.swapWeapon(p.id, w.mass, w.length);
            }
          }
          this.physics.resetSwordPos(p.id, { x: p.pos.x, y: p.pos.y + 1.4, z: p.pos.z });
          this.physics.resetRagPos(p.id, p.pos);
        }
      }
    }

    // Pick up an enemy's dropped sword (stunned/disarmed/dead owner). Walking near
    // it swaps your weapon-type to theirs.
    for (const p of this.players.values()) {
      if (!p.alive || p.bot) {
        if (!p.alive) continue;
      }
      if (now < p.stunUntilMs || now < p.disarmedUntilMs) continue;
      if (p.severedArm) continue;
      if ((p.lastPickupAtMs || 0) > now - 1000) continue;
      for (const q of this.players.values()) {
        if (q === p) continue;
        const qDropped = !q.alive || now < q.stunUntilMs || now < q.disarmedUntilMs;
        if (!qDropped) continue;
        const sw = this.physics.swordState(q.id);
        if (!sw) continue;
        const dx = sw.pos.x - p.pos.x, dz = sw.pos.z - p.pos.z;
        if (dx * dx + dz * dz > 1.0) continue;
        if (p.weaponKey === q.weaponKey) continue;
        p.weaponKey = q.weaponKey;
        p.lastPickupAtMs = now;
        const w = weaponOf(p);
        this.physics.swapWeapon(p.id, w.mass, w.length);
        this.pendingHits.push({ kind: "pickup", id: p.id, weapon: q.weaponKey, at: { x: sw.pos.x, y: 0, z: sw.pos.z } });
        break;
      }
    }

    // Weapon-rack pickups.
    const racks = weaponRacks();
    for (const p of this.players.values()) {
      if (!p.alive || p.bot) {
        // Bots also pick up — but only on cooldown so they don't dance on a rack.
        if (!p.alive) continue;
      }
      if ((p.lastPickupAtMs || 0) > now - 1000) continue;
      if (p.severedArm) continue;
      for (const rk of racks) {
        const dx = p.pos.x - rk.x, dz = p.pos.z - rk.z;
        if (dx * dx + dz * dz < 1.0 && p.weaponKey !== rk.weapon) {
          p.weaponKey = rk.weapon;
          p.lastPickupAtMs = now;
          const w = weaponOf(p);
          this.physics.swapWeapon(p.id, w.mass, w.length);
          this.pendingHits.push({ kind: "pickup", id: p.id, weapon: rk.weapon, at: { x: rk.x, y: 0, z: rk.z } });
          break;
        }
      }
    }

    // Body slam — sprinting players who collide with another player drive them back.
    // Cooldown per attacker. Knocks down the victim only on a heavy hit (very high speed).
    if (this.matchPhase === "playing") {
      const arr = [...this.players.values()];
      const radius2 = (CONFIG.PLAYER.radius * 2) * 1.05;
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (!p.alive) continue;
        if (now - (p.lastSlamAtMs || 0) < 700) continue;
        const pSp = Math.hypot(p.vel.x, p.vel.z);
        // Need real momentum — sprint speed minimum.
        if (pSp < 5.5) continue;
        for (let j = 0; j < arr.length; j++) {
          if (i === j) continue;
          const q = arr[j];
          if (!q.alive) continue;
          if (now - q.spawnedAtMs < CONFIG.PLAYER.spawnInvulnMs) continue;
          if (now - p.spawnedAtMs < CONFIG.PLAYER.spawnInvulnMs) continue;
          const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z;
          const d2 = dx * dx + dz * dz;
          if (d2 > radius2 * radius2) continue;
          // Hit. Direction = attacker's forward into victim.
          const dl = Math.sqrt(d2) || 1;
          const ux = dx / dl, uz = dz / dl;
          const slamMag = 4 + pSp * 0.9;
          q.impulse.x += ux * slamMag;
          q.impulse.z += uz * slamMag;
          q.stamina = Math.max(0, q.stamina - 18);
          if (this.physics) this.physics.pushTorso(q.id, { x: ux * 7, y: 1.5, z: uz * 7 });
          // Hard slam (very fast attacker) → brief knockdown on victim.
          if (pSp > 7.0) {
            q.knockedDownUntilMs = Math.max(q.knockedDownUntilMs, now + 900);
          }
          // Attacker bounces off slightly + loses stamina.
          p.vel.x *= 0.4; p.vel.z *= 0.4;
          p.stamina = Math.max(0, p.stamina - 10);
          p.lastSlamAtMs = now;
          this.pendingHits.push({
            kind: "slam", from: p.id, to: q.id, speed: pSp,
            at: { x: q.pos.x, y: q.pos.y + 0.9, z: q.pos.z },
          });
          break;
        }
      }
    }

    // Combat / match phase machine.
    if (this.matchPhase === "countdown") {
      // Input applied but combat skipped + no movement (server clamps below).
      if (now >= this.phaseUntil) {
        this.matchPhase = "playing";
        this.roundEndsAt = CONFIG.MATCH.roundTimeMs > 0 ? now + CONFIG.MATCH.roundTimeMs : 0;
        this.pendingHits.push({ kind: "matchStart", round: this.roundIndex, roundEndsAt: this.roundEndsAt });
      }
    } else if (this.matchPhase === "playing") {
      // Sword-vs-wall clacks (no damage; just SFX).
      const wallClashes = this.physics.drainWallClashes();
      for (const wc of wallClashes) {
        this.pendingHits.push({ kind: "wallClash", id: wc.id, speed: wc.speed, at: wc.pos });
      }
      const hits = resolveHits(this.players, now, this.physics);
      if (hits.length) {
        this.pendingHits.push(...hits);
        for (const e of hits) {
          if (e.kill) {
            const a = this.players.get(e.from);
            if (a && a.score >= CONFIG.MATCH.scoreToWin) {
              this.endRound(a.id, "score", now);
              break;
            }
          }
        }
      }
      // Round timeout (sudden death: highest score wins; tie → no winner).
      if (this.matchPhase === "playing" && this.roundEndsAt > 0 && now >= this.roundEndsAt) {
        let topScore = -1, topId = null, tied = false;
        for (const p of this.players.values()) {
          if (p.score > topScore) { topScore = p.score; topId = p.id; tied = false; }
          else if (p.score === topScore) tied = true;
        }
        this.endRound(tied ? null : topId, "timeout", now);
      }
    } else if (this.matchPhase === "intermission") {
      if (now >= this.phaseUntil) {
        // Reset scores + respawn everyone, then drop into countdown.
        for (const p of this.players.values()) {
          p.score = 0; p.deaths = 0;
          p.alive = false; p.deadAtMs = 0;
          p.helmIntact = true;
          p.killStreak = 0;
          p.roundDamage = 0;
          p.severedLeg = false;
        }
        this.matchPhase = "countdown";
        this.phaseUntil = now + CONFIG.MATCH.countdownMs;
        this.winnerId = null;
        this.winReason = null;
        this.roundIndex++;
      }
    }
  }

  endRound(winnerId, reason, now) {
    this.matchPhase = "intermission";
    this.winnerId = winnerId;
    this.winReason = reason;
    this.phaseUntil = now + CONFIG.MATCH.intermissionMs;
    const winnerScore = winnerId != null ? (this.players.get(winnerId)?.score ?? 0) : 0;
    // MVP = highest roundDamage.
    let mvpId = null, mvpDmg = 0, mvpName = null;
    for (const p of this.players.values()) {
      if ((p.roundDamage || 0) > mvpDmg) { mvpDmg = p.roundDamage; mvpId = p.id; mvpName = p.name; }
    }
    this.pendingHits.push({
      kind: "matchEnd",
      winner: winnerId, score: winnerScore, reason, round: this.roundIndex,
      mvp: mvpId ? { id: mvpId, name: mvpName, dmg: mvpDmg } : null,
    });
  }

  // Snapshot of public player state.
  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      if (p.zombieUntilMs > Date.now()) continue;            // skip disconnected awaiting rejoin
      const invulnLeft = Math.max(0, CONFIG.PLAYER.spawnInvulnMs - (Date.now() - p.spawnedAtMs));
      const torsoSt = this.physics.torsoState(p.id);
      const headSt = this.physics.headState(p.id);
      players.push({
        id: p.id,
        name: p.name,
        weaponKey: p.weaponKey,
        color: p.color || 0,
        pos: p.pos,
        yaw: p.yaw,
        pitch: p.pitch,
        vel: p.vel,
        hp: p.hp,
        stamina: p.stamina,
        helmIntact: p.helmIntact,
        severedLeg: !!p.severedLeg,
        severedArm: !!p.severedArm,
        crippleMsLeft: Math.max(0, p.crippledUntilMs - Date.now()),
        stunMsLeft:    Math.max(0, p.stunUntilMs    - Date.now()),
        bleedMsLeft:   Math.max(0, p.bleedUntilMs   - Date.now()),
        disarmedMsLeft:Math.max(0, p.disarmedUntilMs- Date.now()),
        knockedMsLeft: Math.max(0, p.knockedDownUntilMs - Date.now()),
        commitMsLeft:  Math.max(0, (p.commitStrikeUntilMs || 0) - Date.now()),
        alive: p.alive,
        weaponTip: p.weaponTip,
        swinging: p.swinging,
        blocking: p.blocking,
        score: p.score,
        deaths: p.deaths,
        lastSeq: p.lastInputSeq,
        moveSpeed: this.moveSpeedFor(p),
        invulnMs: invulnLeft,
        torsoRot: torsoSt ? torsoSt.rot : null,
        headRot:  headSt  ? headSt.rot  : null,
      });
    }
    return {
      t: "snap", tick: this.tick, ts: Date.now(), players,
      props: this.physics.propsState(),
      match: {
        phase: this.matchPhase,
        winnerId: this.winnerId,
        winReason: this.winReason,
        phaseMsLeft: Math.max(0, this.phaseUntil - Date.now()),
        roundMsLeft: this.roundEndsAt > 0 ? Math.max(0, this.roundEndsAt - Date.now()) : 0,
        scoreToWin: CONFIG.MATCH.scoreToWin,
        round: this.roundIndex,
      },
    };
  }

  drainHits() {
    const out = this.pendingHits;
    this.pendingHits = [];
    return out;
  }

  arenaInfo() {
    return {
      size: CONFIG.ARENA.size,
      wallH: CONFIG.ARENA.wallH,
      obstacles: obstacles(),
      racks: weaponRacks(),
    };
  }

  moveSpeedFor(p) {
    return Math.hypot(p.vel.x, p.vel.z);
  }
}
