import { CONFIG } from "./config.js";
import { spawnPoints, obstacles, weaponRacks } from "./arena.js";
import { makePlayer, applyInput, maybeRespawn } from "./player.js";
import { resolveHits } from "./combat.js";
import { botInput, pickBotName, pickBotWeapon, botDifficultyTuning } from "./bot.js";

const BOT_TARGET = Number(process.env.BOT_COUNT ?? 1);
const BOT_DIFFICULTY = (process.env.BOT_DIFFICULTY || "medium").toLowerCase();

export class Room {
  constructor() {
    this.players = new Map();
    this.spectators = new Set();    // sockets that joined when room was full
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

  isFull() { return this.players.size >= CONFIG.MAX_PLAYERS; }

  nextSpawn() {
    const s = this.spawns[this.spawnIdx % this.spawns.length];
    this.spawnIdx++;
    return s;
  }

  addPlayer(name, socket, weaponKey) {
    const p = makePlayer(name, this.nextSpawn(), weaponKey);
    p.socket = socket;
    this.players.set(p.id, p);
    this.ensureBots();
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    // Clean stale references so other players' Maps don't grow unbounded.
    for (const p of this.players.values()) {
      p.lastHitAtMs.delete(id);
      p.parryUntilMs.delete(id);
    }
    this.ensureBots();
  }

  addBot(difficulty = BOT_DIFFICULTY) {
    const name = `[bot] ${pickBotName(this.players)}`;
    const p = makePlayer(name, this.nextSpawn(), pickBotWeapon());
    p.bot = true;
    p.botTuning = botDifficultyTuning(difficulty);
    p.difficulty = difficulty;
    this.players.set(p.id, p);
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

  ensureBots() {
    const humans = this.countHumans();
    let bots = this.countBots();
    let desired = humans > 0 ? Math.min(BOT_TARGET, CONFIG.MAX_PLAYERS - humans) : 0;
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

    const dtMs = 1000 / CONFIG.TICK_HZ;
    // One sim step per player per tick, regardless of input rate.
    const frozen = this.matchPhase === "countdown";
    for (const p of this.players.values()) {
      let input;
      if (p.bot && p.alive && !frozen) {
        input = botInput(p, this.players, now);
      } else if (p.pendingInput && !frozen) {
        input = p.pendingInput;
        p.pendingInput = null;
      } else {
        // Idle / countdown — no movement. Player still gets gravity + tip-vel decay.
        if (p.pendingInput) p.pendingInput = null;
        input = { mv: { x: 0, y: 0 }, yaw: p.yaw, sprint: false, jump: false,
                  blocking: false, swinging: false, weaponTip: p.weaponTip };
      }
      applyInput(p, input, dtMs);
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

    // Respawn dead.
    for (const p of this.players.values()) {
      if (!p.alive) maybeRespawn(p, this.nextSpawn(), now);
    }

    // Weapon-rack pickups.
    const racks = weaponRacks();
    for (const p of this.players.values()) {
      if (!p.alive || p.bot) {
        // Bots also pick up — but only on cooldown so they don't dance on a rack.
        if (!p.alive) continue;
      }
      if ((p.lastPickupAtMs || 0) > now - 1000) continue;
      for (const rk of racks) {
        const dx = p.pos.x - rk.x, dz = p.pos.z - rk.z;
        if (dx * dx + dz * dz < 1.0 && p.weaponKey !== rk.weapon) {
          p.weaponKey = rk.weapon;
          p.lastPickupAtMs = now;
          this.pendingHits.push({ kind: "pickup", id: p.id, weapon: rk.weapon, at: { x: rk.x, y: 0, z: rk.z } });
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
      const hits = resolveHits(this.players, now);
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
    this.pendingHits.push({
      kind: "matchEnd",
      winner: winnerId, score: winnerScore, reason, round: this.roundIndex,
    });
  }

  // Snapshot of public player state.
  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      const invulnLeft = Math.max(0, CONFIG.PLAYER.spawnInvulnMs - (Date.now() - p.spawnedAtMs));
      players.push({
        id: p.id,
        name: p.name,
        weaponKey: p.weaponKey,
        pos: p.pos,
        yaw: p.yaw,
        pitch: p.pitch,
        vel: p.vel,
        hp: p.hp,
        stamina: p.stamina,
        helmIntact: p.helmIntact,
        crippleMsLeft: Math.max(0, p.crippledUntilMs - Date.now()),
        stunMsLeft:    Math.max(0, p.stunUntilMs    - Date.now()),
        bleedMsLeft:   Math.max(0, p.bleedUntilMs   - Date.now()),
        alive: p.alive,
        weaponTip: p.weaponTip,
        swinging: p.swinging,
        blocking: p.blocking,
        score: p.score,
        deaths: p.deaths,
        lastSeq: p.lastInputSeq,
        moveSpeed: this.moveSpeedFor(p),
        invulnMs: invulnLeft,
      });
    }
    return {
      t: "snap", tick: this.tick, ts: Date.now(), players,
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
