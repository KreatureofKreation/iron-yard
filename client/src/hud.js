// HUD overlays. All ID references match index.html.
export const HUD = {
  setHp(cur, max = 100) {
    const f = document.getElementById("hp-fill");
    const n = document.getElementById("hp-num");
    if (!f) return;
    const pct = Math.max(0, Math.min(1, cur / max));
    f.style.width = (pct * 100).toFixed(1) + "%";
    if (n) n.textContent = String(Math.round(cur));
  },
  setStamina(cur, max = 100) {
    const f = document.getElementById("sta-fill");
    if (!f) return;
    const pct = Math.max(0, Math.min(1, cur / max));
    f.style.width = (pct * 100).toFixed(1) + "%";
    f.classList.toggle("low", cur < 20);
  },
  setStance(label) {
    const el = document.getElementById("stance");
    if (el) el.textContent = label;
  },
  setScores(rows, myId) {
    const el = document.getElementById("scoreboard");
    if (!el) return;
    el.innerHTML = rows.map(r => `
      <div class="row ${r.id === myId ? "me" : ""}">
        <span>${escapeHtml(r.name)}</span>
        <span>${r.score}/${r.deaths}</span>
      </div>`).join("");
  },
  log(text) {
    const el = document.getElementById("log");
    if (!el) return;
    const div = document.createElement("div");
    div.className = "line";
    div.textContent = text;
    el.append(div);
    setTimeout(() => div.remove(), 4500);
  },
  killFeed(text) {
    const el = document.getElementById("killfeed");
    if (!el) return;
    const div = document.createElement("div");
    div.className = "row";
    div.textContent = text;
    el.append(div);
    setTimeout(() => div.remove(), 6000);
  },
  flash(strength = 0.35) {
    const el = document.getElementById("flash");
    if (!el) return;
    el.style.background = `rgba(180,30,30,${strength})`;
    requestAnimationFrame(() => {
      el.style.background = "rgba(180,30,30,0)";
    });
  },
  // Show a directional indicator pointing toward the source of incoming damage.
  // angleRad is screen-space angle (0 = up, π/2 = right, etc).
  hitFrom(angleRad) {
    const hud = document.getElementById("hud");
    if (!hud) return;
    const radius = 130;
    const el = document.createElement("div");
    el.className = "hit-arrow";
    el.innerHTML = `<svg viewBox="0 0 60 60">
      <path d="M30 6 L42 24 L34 24 L34 50 L26 50 L26 24 L18 24 Z"
        fill="rgba(220,60,60,0.85)" stroke="rgba(255,200,200,0.9)" stroke-width="1"/>
    </svg>`;
    // position at center then translate outward by radius along angle direction
    const tx = Math.sin(angleRad) * radius;
    const ty = -Math.cos(angleRad) * radius;
    el.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) rotate(${angleRad}rad)`;
    hud.append(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => el.classList.remove("show"), 900);
    setTimeout(() => el.remove(), 1300);
  },
  setDead(on) {
    const el = document.getElementById("dead");
    if (el) el.style.display = on ? "flex" : "none";
  },
  showBanner(html, durationMs = 0) {
    const el = document.getElementById("banner");
    if (!el) return;
    el.innerHTML = html;
    el.style.display = "block";
    if (durationMs > 0) setTimeout(() => { el.style.display = "none"; }, durationMs);
  },
  hideBanner() {
    const el = document.getElementById("banner");
    if (el) el.style.display = "none";
  },
  setMenu(visible, statusText) {
    const m = document.getElementById("menu");
    if (m) m.style.display = visible ? "flex" : "none";
    if (statusText != null) {
      const s = document.getElementById("status");
      if (s) s.textContent = statusText;
    }
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" }[c]));
}
