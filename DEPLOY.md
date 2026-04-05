# Jigsaw Together — Deployment Guide

## Overview

Recommended approach: **GitHub → manual pull on droplet** (simplest, zero-config).
Optional: **GitHub Actions** for one-command deploys after setup.

Domain in use: **game.wandanial.com** (Cloudflare A record, DNS-only / no proxy).

---

## 1. One-time Droplet Setup

SSH into your droplet:

```bash
ssh root@YOUR_DROPLET_IP
```

### Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v   # should show v20.x
```

### Install PM2 (process manager — keeps app alive after SSH exit)

```bash
npm install -g pm2
```

### Install git

```bash
apt-get install -y git
```

### Create app user (optional but good practice)

```bash
adduser --disabled-password --gecos "" jigsaw
su - jigsaw
```

---

## 2. Clone & First Deploy

```bash
# As root or jigsaw user
cd /home/jigsaw   # or /root if using root
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git jigsaw
cd jigsaw
npm install
```

### Start with PM2

```bash
pm2 start server.js --name jigsaw
pm2 save
pm2 startup   # follow the printed command to auto-start on reboot
```

App is now running on **port 3000**.

---

## 3. Nginx Reverse Proxy (port 80/443)

If your droplet already runs Caddy on ports 80/443 (as in your case), skip nginx/Certbot and use Caddy for TLS instead.

### Option A: Caddy (recommended if Caddy is already installed)

Caddy can proxy the app and automatically manage HTTPS certificates.

Edit `/etc/caddy/Caddyfile`:

```caddy
game.wandanial.com {
  reverse_proxy 127.0.0.1:3000
}
```

Then reload Caddy:

```bash
sudo caddy fmt --overwrite /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### Option B: Nginx + Certbot

Only use this if nothing else is listening on ports 80/443.

```bash
apt-get update
apt-get install -y nginx
```

Create `/etc/nginx/sites-available/jigsaw`:

```nginx
server {
    listen 80;
  server_name game.wandanial.com;

    client_max_body_size 10M;   # allow image uploads

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";   # required for Socket.io
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
ln -s /etc/nginx/sites-available/jigsaw /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

### Add HTTPS (free, via Certbot)

```bash
apt-get update
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d game.wandanial.com
```

If `nginx` or `certbot` is still missing on the droplet, install them first with the commands above. On a fresh server, they are not installed by default.

### If port 80/443 is already in use

Check what owns the ports:

```bash
sudo ss -ltnp | grep ':80\|:443'
```

If you see `caddy`, do not use Certbot/nginx on those ports. Keep Caddy running and use the Caddyfile shown above.

Certbot auto-renews. Done.

> If Cloudflare is used, keep this DNS record in **DNS-only** mode while issuing/renewing certs directly on the droplet.

### If you see `SSL_ERROR_INTERNAL_ERROR_ALERT`

This usually means nginx/Certbot on the droplet has a bad or incomplete TLS config.

Run these on the droplet:

```bash
sudo nginx -t
sudo certbot --nginx -d game.wandanial.com
sudo systemctl reload nginx
```

If Certbot reports the certificate already exists but the browser still errors, remove and reissue it:

```bash
sudo certbot delete --cert-name game.wandanial.com
sudo certbot --nginx -d game.wandanial.com
sudo systemctl reload nginx
```

Make sure your DNS record stays on **DNS-only** in Cloudflare and points to the droplet IP.

---

## 4. Deploying Updates (Manual Pull)

Every time you push code changes:

```bash
ssh root@YOUR_DROPLET_IP
cd /home/jigsaw/jigsaw   # your repo path
git pull
npm install              # only needed if package.json changed
pm2 restart jigsaw
```

That's it. Zero downtime restart with PM2.

---

## 5. GitHub Actions (Optional — Auto-Deploy on Push)

### On your droplet, create a deploy SSH key

```bash
ssh-keygen -t ed25519 -C "github-deploy" -f ~/.ssh/github_deploy -N ""
cat ~/.ssh/github_deploy.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/github_deploy      # copy this — you'll add it to GitHub
```

### In your GitHub repo → Settings → Secrets and variables → Actions

Add these secrets:

- `DROPLET_HOST` → your droplet IP
- `DROPLET_USER` → `root` (or `jigsaw`)
- `DEPLOY_KEY` → the private key content from above
- `DEPLOY_KEY_PASSPHRASE` → passphrase for that private key
- `DEPLOY_PATH` → optional absolute app path on droplet (defaults to `$HOME/gameroom`)
- `REPO_CLONE_URL` → optional repo clone URL (needed for private repos)

Use one of these `DEPLOY_PATH` values if you want to force a custom location:

- `/home/jigsaw/jigsaw` (if deploying as user `jigsaw`)
- `/root/gameroom` (if deploying as user `root`)

For a brand-new droplet, you can leave `DEPLOY_PATH` unset and the workflow will clone into `$HOME/gameroom` on first run.

If the repo is private, set `REPO_CLONE_URL` to an SSH URL like:

```text
git@github.com:YOUR_USERNAME/gameroom.git
```

and make sure that droplet user has a GitHub deploy key configured.

Quick way to confirm path on droplet:

```bash
cd /home/jigsaw/gameroom 2>/dev/null || cd /root/gameroom
pwd
```

If Actions fails with `APP_DIR exists but is not a git repo`, your `DEPLOY_PATH` points to a non-empty folder.
Use an empty folder (or remove old files) and rerun.

### Workflow file

The workflow is already in this repo at `.github/workflows/deploy.yml`.

```yaml
name: Deploy to DigitalOcean

on:
  push:
    branches: [master]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.2.0
        with:
          host: ${{ secrets.DROPLET_HOST }}
          username: ${{ secrets.DROPLET_USER }}
          key: ${{ secrets.DEPLOY_KEY }}
          passphrase: ${{ secrets.DEPLOY_KEY_PASSPHRASE }}
          script: |
            set -e
            APP_DIR="${{ secrets.DEPLOY_PATH }}"
            if [ -z "$APP_DIR" ]; then
              APP_DIR="$HOME/gameroom"
            fi

            REPO_URL="${{ secrets.REPO_CLONE_URL }}"
            if [ -z "$REPO_URL" ]; then
              REPO_URL="${{ github.server_url }}/${{ github.repository }}.git"
            fi

            if [ ! -d "$APP_DIR/.git" ]; then
              mkdir -p "$APP_DIR"
              git clone --branch master "$REPO_URL" "$APP_DIR"
            fi

            cd "$APP_DIR"
            git remote set-url origin "$REPO_URL" || true
            git fetch origin master
            git reset --hard origin/master
            npm ci --omit=dev

            if pm2 describe jigsaw >/dev/null 2>&1; then
              pm2 restart jigsaw --update-env
            else
              pm2 start server.js --name jigsaw
            fi

            pm2 save
```

Now every `git push` to `master` auto-deploys. GitHub Actions runs free for public repos.

---

## 6. Useful PM2 Commands

```bash
pm2 status           # see if app is running
pm2 logs jigsaw      # live logs
pm2 restart jigsaw   # restart
pm2 stop jigsaw      # stop
pm2 monit            # live CPU/memory dashboard
```

---

## 7. Environment Variables (optional)

Create `/home/jigsaw/jigsaw/.env` (never commit this):

```bash
PORT=3000
```

Or set via PM2:

```bash
pm2 restart jigsaw --update-env
```

---

## 8. Disk Cleanup Cron (important on 1GB storage)

Completed puzzle images accumulate. Add a daily cleanup:

```bash
crontab -e
```

Add this line:

```
0 3 * * * find /home/jigsaw/jigsaw/public/completed -name "*.jpg" -mtime +7 -delete
0 3 * * * find /home/jigsaw/jigsaw/uploads -name "*" -mtime +1 -delete
```

This deletes completed images older than 7 days, and stale uploads older than 1 day.

---

## 9. Memory Check

Your droplet has 512MB RAM. With Node + PM2 + nginx the baseline is ~80MB.
Each active puzzle room uses ~5MB. You have comfortable headroom for 2–10 players.

Monitor live:

```bash
pm2 monit
# or
free -h
```

If memory grows unexpectedly:

```bash
pm2 restart jigsaw   # clears in-memory rooms (players will need to rejoin)
```

---

## Summary Checklist

- [ ] Node 20 installed
- [ ] PM2 installed & app started
- [ ] `pm2 save` + `pm2 startup` done (survives reboots)
- [ ] Nginx configured with `client_max_body_size 10M`
- [ ] HTTPS via Certbot
- [ ] Cron cleanup job set
- [ ] (Optional) GitHub Actions deploy workflow added
