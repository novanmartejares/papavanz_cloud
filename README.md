# papavanz_cloud — Private Cloud Storage & Backup

Self-hosted, multi-user file backup for a small team. Runs on a spare PC,
reachable on the LAN and (optionally) over the public internet via
Cloudflare Tunnel. Per-user 5 GB quota, isolated folders, IDOR-safe by
design.

> **Status:** v1 scaffold — auth, file CRUD, quota, IDOR protection, and
> a minimal React UI all working end-to-end. See
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design and
> the deploy runbook.

``` 
papavanz_cloud/
├── server/            ← Node 20 + Express + Prisma + SQLite API
├── web/               ← React + Vite frontend
└── docs/              ← architecture + deploy runbook
```

---

## Quick start (development)

You need Node 20+ and npm. Two terminals.

```bash
# 1) backend
cd server
cp .env.example .env
# edit .env — at minimum set JWT_SECRET to something long and random:
#   openssl rand -base64 48
npm install
npx prisma migrate dev          # creates SQLite db and applies the schema
npm run dev                     # http://localhost:8080
```

```bash
# 2) frontend
cd web
npm install
npm run dev                     # http://localhost:5173
```

Open `http://localhost:5173`, register an account, upload a file. The
file lands in `server/storage/user_<your-uuid>/<random-uuid>` — never
under its original name, never outside your folder.

Run the backend test suite:

```bash
cd server
npm test
```

It exercises register → login → upload → list → download → IDOR-block →
quota → delete.

---

## What's implemented

- **Auth.** `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`.
  bcrypt(cost 12) password hashes, JWT in an httpOnly cookie, also
  accepted as `Authorization: Bearer …` for CLI clients.
- **Per-user folder.** Created on registration at
  `STORAGE_ROOT/user_<user.id>` with `chmod 700`.
- **File CRUD.** `GET /api/files`, `POST /api/files` (multipart, field
  name `file`), `GET /api/files/:id`, `GET /api/files/:id/download`,
  `DELETE /api/files/:id`.
- **5 GB quota** enforced inside a DB transaction so concurrent uploads
  cannot bypass it. Returns **413** when exceeded.
- **IDOR protection.** Every file row lookup is scoped to
  `where: { id, userId: req.user.id }`. Cross-user requests return 404.
- **Path-traversal protection.** Stored filenames are UUIDs and the
  resolved on-disk path is validated to live inside the user's folder.
- **Hardening.** `helmet()`, `express-rate-limit` on `/auth/*` and
  `/api/*`, JSON body size limit, CORS allow-list.
- **Frontend.** Login/register, storage progress bar, file list with
  download/delete, upload with per-file progress.

---

## Deploying on the spare PC

Full step-by-step runbook (systemd unit, Cloudflare Tunnel install,
nightly rsync mirror, sqlite backup) is in
[`docs/DEPLOY.md`](docs/DEPLOY.md).

The short version:

1. Mount an external HDD at `/mnt/backup-primary` and point
   `STORAGE_ROOT` at `/mnt/backup-primary/cloud-storage`.
2. Run as a systemd service (`server/deploy/papavanz-cloud.service`).
3. `cloudflared tunnel create papavanz-cloud` → route a subdomain → run
   the tunnel as a service (`cloudflared service install`).
4. Add the nightly `rsync -aH --delete` mirror cron + sqlite snapshot.

---

## Decisions made for v1

- **Open registration.** Anyone with the URL can sign up. Easy to swap
  to invite-codes later (one column on `users`, one guard on `/auth/register`).
  Recommended: front the whole app with **Cloudflare Access** so only your
  team's emails can even reach the login page.
- **No encryption at rest.** Files are stored plain on the disk. Before
  going live with sensitive data, enable LUKS on the storage volume —
  the runbook has the commands.
- **SQLite.** Zero-ops for a single PC. Migrating to Postgres later only
  requires changing the `provider` line in `prisma/schema.prisma` and
  re-running migrations.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full design
rationale.

---

## License

UNLICENSED — internal tool.
