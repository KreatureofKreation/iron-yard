# Public-facing deployment

Goal: a stable URL anyone can click. Three options ordered by friction.

## Option A — Cloudflare Tunnel (no signup, instant share)

Run the server locally, expose it through a Cloudflare-issued URL. The URL stays alive while the tunnel runs. Best for impromptu sessions with friends.

```powershell
# Install once.
winget install --id Cloudflare.cloudflared
# OR Mac/Linux: brew install cloudflared

# In one terminal: run the game.
.\start.bat

# In another terminal: open the tunnel pointing at the local game.
cloudflared tunnel --url http://localhost:8080
```

Cloudflare prints a `https://<random>.trycloudflare.com` URL — share that. WebSocket works through the tunnel automatically.

Trade-offs: random subdomain, dies when you close the terminal, only as available as your machine.

## Option B — Fly.io (free tier, persistent URL)

Persistent `https://<app>.fly.dev` URL. Free tier handles a small instance fine.

```bash
# Install once.
curl -L https://fly.io/install.sh | sh   # or: brew install flyctl
fly auth signup                          # or fly auth login

cd "Game idea"
# Edit fly.toml — change `app = "iron-yard"` to a name you control.
fly launch --no-deploy --copy-config
fly deploy
fly open
```

Notes: `auto_stop_machines = "off"` is set in `fly.toml` so the machine doesn't pause and disconnect WS clients mid-match. Set `BOT_COUNT` / `BOT_DIFFICULTY` / `SCORE_TO_WIN` via `fly secrets set NAME=value` for runtime config.

## Option C — Render.com (free tier, GitHub-deployed)

Persistent `https://iron-yard.onrender.com` URL. Free tier spins down after 15 min idle (next request takes ~30s to wake), so good for casual sharing.

1. Push this repo to GitHub.
2. Sign in to render.com → New → Blueprint → point at the repo.
3. Render reads `render.yaml`, builds the Dockerfile, deploys.
4. Add a custom domain in the Render dashboard if you want `play.example.com`.

## Custom domain (`.io` etc.)

Buy a `.io` (Porkbun, Namecheap, Cloudflare — typically $30–60/yr).

After deploy:
- **Fly.io**: `fly certs add play.example.io` then add the DNS record they tell you to in your registrar.
- **Render**: add the domain in the dashboard, copy the DNS records, paste into your registrar.
- **Cloudflare Tunnel + named tunnel**: `cloudflared tunnel route dns <tunnel> play.example.io` (requires running the tunnel as a service; see `cloudflared service install`).

## Local network only

If you just want LAN co-op (laptops on the same Wi-Fi):

```powershell
.\start.bat
# Find your LAN IP:
ipconfig | findstr IPv4
# Friends visit  http://<your-lan-ip>:8080
```

The server already binds to `0.0.0.0` so any device on the network reaches it. Windows may prompt to allow Node through the firewall — accept "Private networks" only.
