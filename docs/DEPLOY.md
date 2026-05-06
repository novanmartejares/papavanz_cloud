# Deploy runbook

This is the step-by-step for getting `papavanz_cloud` running on the
spare PC and reachable over the internet. Assumes Ubuntu/Debian. Adapt
for other distros.

---

## 1. Prepare the server PC

```bash
# install Node 20 LTS via nodesource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# create a dedicated unprivileged user
sudo useradd --system --create-home --shell /usr/sbin/nologin cloud
```

## 2. Provision the storage disk

Plug in your external HDD. Identify it (`lsblk`), format if needed
(`sudo mkfs.ext4 /dev/sdX1`), then mount it:

```bash
sudo mkdir -p /mnt/backup-primary
sudo mount /dev/sdX1 /mnt/backup-primary
# add to /etc/fstab so it remounts on boot:
echo "UUID=$(sudo blkid -s UUID -o value /dev/sdX1)  /mnt/backup-primary  ext4  defaults,nofail  0  2" | sudo tee -a /etc/fstab

sudo mkdir -p /mnt/backup-primary/cloud-storage
sudo chown -R cloud:cloud /mnt/backup-primary/cloud-storage
sudo chmod 700 /mnt/backup-primary/cloud-storage
```

(Optional but recommended for sensitive data — encrypt the volume:
`sudo cryptsetup luksFormat /dev/sdX1` then mount via `/etc/crypttab`.)

## 3. Clone and build

```bash
sudo -u cloud -H bash <<'EOF'
cd ~
git clone https://github.com/novanmartejares/papavanz_cloud.git
cd papavanz_cloud

# backend
cd server
npm ci --omit=dev
cp .env.example .env
# edit .env:
#   JWT_SECRET=<openssl rand -base64 48>
#   STORAGE_ROOT=/mnt/backup-primary/cloud-storage
#   DATABASE_URL=file:/home/cloud/papavanz_cloud/server/data/app.db
#   NODE_ENV=production
#   HOST=127.0.0.1   # tunnel-only; no LAN. Use 0.0.0.0 if you also want LAN.
mkdir -p data
npx prisma migrate deploy

# frontend (build static, then symlink into the API or serve via nginx)
cd ../web
npm ci
npm run build
EOF
```

## 4. Run the API as a systemd service

Create `/etc/systemd/system/papavanz-cloud.service`:

```ini
[Unit]
Description=papavanz_cloud private storage API
After=network.target

[Service]
Type=simple
User=cloud
Group=cloud
WorkingDirectory=/home/cloud/papavanz_cloud/server
EnvironmentFile=/home/cloud/papavanz_cloud/server/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=3
# tighten the sandbox
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/cloud/papavanz_cloud/server/data /mnt/backup-primary/cloud-storage

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now papavanz-cloud
sudo systemctl status papavanz-cloud
curl http://127.0.0.1:8080/health    # expect {"ok":true}
```

## 5. Serve the frontend

Two options. Pick one.

### Option A — same origin via nginx (LAN + tunnel)

```bash
sudo apt-get install -y nginx
```

`/etc/nginx/sites-available/papavanz-cloud`:

```nginx
server {
  listen 80 default_server;
  server_name _;

  client_max_body_size 5G;            # match the per-upload cap

  root /home/cloud/papavanz_cloud/web/dist;
  index index.html;

  location /api/  { proxy_pass http://127.0.0.1:8080;
                    proxy_set_header Host $host;
                    proxy_set_header X-Forwarded-For $remote_addr;
                    proxy_request_buffering off; }
  location /auth/ { proxy_pass http://127.0.0.1:8080;
                    proxy_set_header Host $host;
                    proxy_set_header X-Forwarded-For $remote_addr; }
  location /health{ proxy_pass http://127.0.0.1:8080; }

  # SPA fallback
  location / { try_files $uri /index.html; }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/papavanz-cloud /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

LAN: visit `http://<server-lan-ip>/` from any device on the network.

### Option B — frontend on a different host

Just `npm run dev` from another machine, pointed at the API URL via
`vite.config.ts` proxy. Not recommended for production.

## 6. Cloudflare Tunnel (public access)

```bash
# install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# auth (opens a browser to pick your CF zone)
cloudflared tunnel login

# create + route DNS
cloudflared tunnel create papavanz-cloud
cloudflared tunnel route dns papavanz-cloud backup.example.com   # use your domain

# config the tunnel to point at nginx (or directly at :8080 if you skipped nginx)
cat <<EOF | sudo tee /etc/cloudflared/config.yml
tunnel: papavanz-cloud
credentials-file: /home/$USER/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: backup.example.com
    service: http://localhost:80
  - service: http_status:404
EOF

# install + start as a service
sudo cloudflared service install
sudo systemctl status cloudflared
```

Then `https://backup.example.com` proxies straight to your PC. No port
forwarding, free TLS, IP changes don't matter.

**Highly recommended:** in the Cloudflare Zero Trust dashboard, add an
**Access** policy on `backup.example.com` requiring your team's email
addresses. The login page becomes Cloudflare-protected — only known
people can even reach it.

## 7. Redundancy

### Mirror the storage disk nightly

Plug in a second disk, mount at `/mnt/backup-secondary`, then add a
cron job:

```bash
sudo crontab -e
```

```
# nightly mirror of cloud storage
0 3 * * *  rsync -aH --delete /mnt/backup-primary/ /mnt/backup-secondary/  >> /var/log/cloud-mirror.log 2>&1

# nightly sqlite snapshot (file metadata is just as important as the files)
30 3 * * * sqlite3 /home/cloud/papavanz_cloud/server/data/app.db ".backup /mnt/backup-secondary/app.db.$(date +\%u).bak"
```

The sqlite cron keeps a 7-day rotation by day-of-week.

### Future: ZFS / Btrfs

When you outgrow rsync, move to ZFS RAID-1 — atomic snapshots, automatic
mirroring, easy rollbacks.

## 8. Tunnel-only mode (no LAN)

If you want the API to be reachable **only** through Cloudflare Tunnel
(maximum security), set `HOST=127.0.0.1` in `.env` and skip the nginx
LAN config. The tunnel runs on the same PC and connects to localhost.

## 9. Health checks

- `GET /health` returns `{"ok":true}` — wire it into Cloudflare uptime
  monitoring or any external pinger.
- `journalctl -u papavanz-cloud -f` for live logs.
- `journalctl -u cloudflared -f` for tunnel logs.

## 10. Updating

```bash
sudo -u cloud -H bash <<'EOF'
cd /home/cloud/papavanz_cloud
git pull
cd server && npm ci --omit=dev && npx prisma migrate deploy
cd ../web && npm ci && npm run build
EOF
sudo systemctl restart papavanz-cloud
sudo systemctl reload nginx
```
