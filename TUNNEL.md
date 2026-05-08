# Hosting Iron Yard

## Option A — Quick tunnel (random URL, no account)

Zero setup. New random URL each run. Best for one-off play sessions.

```
tunnel.bat        (Windows)
./tunnel.sh       (macOS/Linux)
```

URL printed in the terminal: `https://<random>.trycloudflare.com`. Share with friends.

## Option B — Named tunnel (stable URL, free Cloudflare account, requires a domain)

Same URL every time. Survives restarts. Friends bookmark it once.

### Prerequisites

1. **Domain** managed by Cloudflare DNS (free plan is fine).
   - If you don't have one: register a `.com` for ~$10/yr at any registrar (Namecheap, Porkbun, Cloudflare Registrar). Cloudflare Registrar sells at cost.
   - Cheaper free alt: a free subdomain on someone else's Cloudflare zone (e.g., a friend's), or pay $10/yr.
2. **Cloudflare account** (free).
3. **cloudflared** installed (same as Quick tunnel).

### One-time setup

Run these commands once. They open a browser to authorize cloudflared and store credentials at `~/.cloudflared/`.

```
cloudflared tunnel login
cloudflared tunnel create iron-yard
```

The `create` command prints a tunnel UUID and writes a credentials JSON. Note the UUID.

Route DNS — pick a hostname under your zone:

```
cloudflared tunnel route dns iron-yard play.yourdomain.com
```

This creates a CNAME in Cloudflare DNS pointing `play.yourdomain.com` → tunnel UUID.

### Config file

Create `%USERPROFILE%\.cloudflared\config.yml` (Windows) or `~/.cloudflared/config.yml` (Unix):

```yaml
tunnel: iron-yard
credentials-file: <full path to the .json that 'create' produced>

ingress:
  - hostname: play.yourdomain.com
    service: http://localhost:8080
  - service: http_status:404
```

### Daily run

```
tunnel-named.bat      (Windows)
./tunnel-named.sh     (macOS/Linux)
```

Builds the client, starts the server on :8080, runs the named tunnel. Friends visit `https://play.yourdomain.com` — same URL every time.

### Tearing down

```
cloudflared tunnel delete iron-yard
```

DNS record removes itself when the tunnel is deleted.

---

## Option C — Render (current default, has cold-start)

`git push origin main` auto-deploys to https://iron-yard.onrender.com. Free tier sleeps after 15 min idle (~30s cold start). No setup beyond Render account.
