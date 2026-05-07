# Iron Yard

Browser multiplayer physics-flavored medieval melee. Up to 4 players in a walled arena. Motion-driven attacks — the sword's motion IS the swing; speed of the tip dictates damage. Mobile twin-stick + desktop mouse/WASD.

Not affiliated with Half Sword. Inspired by similar mechanics, all original code.

## Camera

Third-person, **fixed orientation** by default. Avoids the feedback-loop spin you get when the camera trails the player while the player faces the camera-relative input. Rotate manually with **Q/E** on desktop. Camera initial yaw points toward arena center on join.

## Bots

Server auto-fills with bots when humans are present. Default `BOT_COUNT=1` per room. Bots are removed when the room fills with humans.

```
BOT_COUNT=2 npm --prefix server start
```

Bot AI: pick nearest target → close to within weapon reach → strafe-and-swing in arc → block when low HP → respawn after 3s. Each bot picks a random weapon at spawn.

## Current features

- **4 weapons**: arming sword, longsword, mace, spear — each with own length/mass/damage curve, hit cooldown, and special trait (mace = blunt-bypasses-some-block, spear = thrust bonus, longsword = reach + heft)
- **Body-part hit zones**: head 1.8×, torso 1×, legs 0.7× + slow/snare on leg hit
- **Block** (F / button): 85% reduction front, 40% to the side. Mace ignores 30% of block reduction.
- **Parry/clash**: when two players' weapons cross while both moving fast, both bounce — no damage that frame
- **Stamina** (100 max): sprint/block/jump/big-swing drain. Exhausted attackers deal 50% damage. Regens when idle.
- **Knockback** as a separate impulse channel that decays over ~115ms (won't be wiped by movement input)
- **Smooth movement** with acceleration; tip-velocity computation excludes player translation so walking/jumping isn't a free swing
- **Bot opponents**: auto-spawn to fill the room, pick random weapon, approach + strafe + dodge incoming high-speed swings, block when low HP, jitter when stuck
- **Audio** (procedural Web Audio, no asset files): swing whoosh, metallic hit, blade clash, hurt grunt, death rumble
- **Visual feedback**: screen shake, hit flash, directional hit-from indicator, sparks colored by zone, blade trail when sword moves fast, spawn-invulnerability translucent pulse
- **Walk + idle animation**, slumped death pose, scoreboard, kill feed
- **Anti-cheat**: server processes one input per tick regardless of client send rate; weapon-tip world position clamped to plausible reach
- **Round/match system**: first-to-N kills wins, victory banner + fanfare, auto-reset after intermission. `SCORE_TO_WIN=N`, `INTERMISSION_MS=N` envs.
- **Helmet detach** on lethal headshot — helm flies off as a falling prop, restored on respawn
- **Spatial audio**: hits/clashes/death/whoosh pan by world position relative to camera
- **Bot difficulty**: `BOT_DIFFICULTY=easy|medium|hard` env; tunes swing rate, aim slop, dodge alertness, block chance
- **Career stats** (localStorage): K/D/W/L visible on menu; auto-tracked from kills + match wins
- **Remote nameplates** show name + weapon + HP bar + stamina bar over each player

## Stack

- **Client**: Three.js (r169) + Vite, ES modules
- **Server**: Node.js (>=18) + `ws`, single-room, authoritative
- **Network**: WebSocket JSON, 30Hz tick, 20Hz snapshots, 60Hz client input, 100ms interp delay
- **Combat math**: segment-vs-capsule sweep; damage = clamp((tipSpeed - 4 m/s) × 4 × massFactor, 6, 45)

## Quickstart

**Windows: just double-click `start.bat`.** It installs deps, builds the client, and runs the server. Open http://localhost:8080.

For dev mode with hot-reload: double-click `dev.bat` — opens server + vite dev in two windows. Open http://localhost:5173.

**Manual / cross-platform**:

```bash
# Once
npm --prefix server install
npm --prefix client install

# Dev (vite on :5173, ws server on :8080)
npm --prefix server run dev      # one terminal
npm --prefix client run dev      # another terminal
# open http://localhost:5173

# Production (single URL on :8080)
npm --prefix client run build
npm --prefix server start
# open http://localhost:8080 — share that URL, anyone clicks PLAY
```

Override defaults via env vars: `BOT_COUNT=2`, `PORT=9000`. On Windows cmd: `set BOT_COUNT=2 && start.bat`. PowerShell: `$env:BOT_COUNT=2; .\start.bat`.

## Controls

| Action       | Desktop                          | Mobile (landscape)   |
|--------------|----------------------------------|----------------------|
| Move         | WASD / arrow keys                | Left stick           |
| Sword aim    | Mouse position                   | Right stick          |
| Swing        | Move sword fast — motion = damage| Move right stick fast|
| Block        | F                                | BLOCK button         |
| Sprint       | Shift                            | RUN button           |
| Jump         | Space                            | JUMP button          |
| Zoom camera  | Mouse wheel                      | (n/a)                |

The sword's motion is the swing — there is no separate attack button. Slow, controlled movements won't damage opponents (parry/poke). Whip the sword fast and the tip will cut.

Block reduces damage 85% if facing the attacker, 40% to the side.

## URL params

- `?name=alice` — preset name
- `?weapon=mace` — preset weapon (arming, longsword, mace, spear)
- `?ws=ws://host:port` — override WebSocket URL
- `?auto=1` — auto-join on load (skip menu)
- `?dev=1` — show server URL field in menu

## Weapons

| Weapon       | Length | Mass | Min swing | Max dmg | Cooldown | Trait                          |
|--------------|--------|------|-----------|---------|----------|--------------------------------|
| Arming sword | 1.10m  | 1.10kg | 4.0 m/s | 45      | 350ms    | balanced one-hand              |
| Longsword    | 1.30m  | 1.50kg | 3.5 m/s | 60      | 450ms    | reach + heavy strikes          |
| Mace         | 0.80m  | 1.40kg | 3.0 m/s | 70      | 500ms    | blunt — bypasses 30% of block  |
| Spear        | 2.10m  | 1.20kg | 5.0 m/s | 55      | 400ms    | +40% damage when thrusting     |

## Files

```
client/
  index.html       menu + HUD overlays
  src/main.js      render loop, network glue, camera, prediction
  src/scene.js     Three.js scene + arena
  src/character.js stylized humanoid + sword rig
  src/input.js     twin-stick + WASD/mouse, aim sampler
  src/network.js   WebSocket client
  src/hud.js       HP, scoreboard, killfeed, flash
  src/config.js    runtime constants

server/
  src/index.js     http (serves client/dist) + ws bind + sim loop
  src/room.js      tick, snapshot, hit drain
  src/player.js    capsule, input application, weapon segment
  src/combat.js    swing-vs-target resolver, damage formula
  src/arena.js     spawn points, walls, pillars, clamp
  src/config.js    tunables (tick rate, damage, etc)
  src/math.js      segment-vs-capsule + small vec3 helpers
```

## Tunables (server/src/config.js)

- Arena 30×30m, 4 corner spawns, 4 pillars
- Player capsule 0.4m radius × 1.8m tall, 100 HP, 3s respawn, 1.5s spawn invuln
- Arming sword: 1.1m total length, 1.1kg, min damage speed 4 m/s, max damage 45
- Per-target hit cooldown 350ms

## Known limitations of first draft

- No client-side movement reconciliation rollback — server snaps trump client predicted pos with a 25% lerp; you'll feel rubberband on packet loss.
- Single global room. No matchmaking.
- No real ragdoll on death, just a slumped pose.
- No audio.
- Pillars are AABB; capsule clamp is naive (works for low speeds).
- One weapon. Other medieval arms (longsword, mace, spear, dagger) — to be added.

## Roadmap (next drafts)

1. Active ragdoll on death (Rapier3D)
2. Weapon roster: longsword (two-hand, more reach, 2× swing weight), mace (blunt, higher damage but slower), spear (long thrust)
3. Stamina + parries (clash mid-swing if both swords meet)
4. Body-part hit zones (head crit, leg cripple)
5. Multiple rooms + queue
6. Binary protocol (msgpack), delta compression
