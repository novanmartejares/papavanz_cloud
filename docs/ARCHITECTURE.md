# Architecture

> Implementation reference for `papavanz_cloud`. The README has the
> quick-start; this doc explains the why and lists the design decisions
> in one place.

---

## High-level diagram

```
        ┌────────────────────────────────────────────┐
        │              Public Internet               │
        └──────────────────────┬─────────────────────┘
                               │  HTTPS (443)
                ┌──────────────▼──────────────┐
                │   Cloudflare Tunnel
                │   - TLS termination
                │   - DDoS / WAF
                │   - Zero-Trust auth (optional)
                └──────────────┬──────────────┘
                               │  http://127.0.0.1:8080
                ┌──────────────▼──────────────┐
                │      Local Server PC        │
                │  ┌───────────────────────┐  │
                │  │  Node + Express API   │  │  ← auth, quota, file I/O
                │  │  (systemd service)    │  │
                │  └────────┬──────────────┘  │
                │           │                  │
                │  ┌────────▼──────────┐       │
                │  │   SQLite (Prisma) │       │  ← users + file metadata
                │  └───────────────────┘       │
                │                              │
                │  ┌──────────────────────┐    │
                │  │ /mnt/backup-primary/ │    │
                │  │  cloud-storage/      │    │  ← per-user folders on
                │  │   ├─ user_<uuid>/    │    │     external HDD
                │  │   └─ user_<uuid>/    │    │
                │  └──────────────────────┘    │
                └──────────────────────────────┘
                       │ nightly
            ┌──────────▼───────────┐
            │  rsync mirror to     │
            │  /mnt/backup-secondary│  ← redundancy on second disk
            └──────────────────────┘
```

Three planes:

1. **Edge** — Cloudflare Tunnel exposes the API without opening router
   ports. Free TLS, optional Zero-Trust SSO via Cloudflare Access.
2. **App** — Express, stateless. State lives in (a) SQLite and (b) the
   storage volume. The process can be restarted at any time.
3. **Storage** — One folder per user on a dedicated disk, mirrored
   nightly to a second disk.

---

## Tech stack

| Layer       | Choice                          | Why                                                              |
|-------------|---------------------------------|------------------------------------------------------------------|
| Runtime     | Node.js 20 LTS                  | Streams keep memory stable on multi-GB uploads/downloads.        |
| Framework   | Express 4                       | Minimal, battle-tested, plays well with `multer` + streams.      |
| Auth        | bcrypt + JWT (httpOnly cookie)  | No session store; works with browsers and CLIs.                  |
| Uploads     | multer (disk storage, 2.x)      | Streams to a temp file; no full buffer in RAM.                   |
| ORM/DB      | Prisma + SQLite                 | Zero-ops on a single PC. Swap to Postgres later if needed.       |
| Frontend    | React + Vite + TypeScript       | Familiar stack, no SSR needed.                                   |
| Process mgr | systemd                         | Auto-restart on crash, starts on boot.                           |
| Tunnel      | Cloudflare Tunnel               | No port forwarding, free TLS, optional SSO.                      |

---

## Data model

```prisma
model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  storageQuota BigInt   @default(5368709120)   // 5 GB
  storageUsed  BigInt   @default(0)
  createdAt    DateTime @default(now())
  files        File[]
}

model File {
  id           String   @id @default(uuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  originalName String                          // what the user uploaded
  storedName   String                          // random uuid on disk
  mimeType     String?
  sizeBytes    BigInt
  sha256       String?                         // optional integrity hash
  createdAt    DateTime @default(now())

  @@unique([userId, originalName])
  @@index([userId])
}
```

`storage_used` is the source of truth for the quota check, updated in the
same transaction as the file row so it cannot drift. A nightly job (not
yet implemented) reconciles it against `SUM(size_bytes)`.

---

## API surface

All `/api/*` routes require a valid JWT (cookie or Authorization header).

| Method | Path                       | Purpose                                 |
|--------|----------------------------|-----------------------------------------|
| POST   | `/auth/register`           | create user + create their folder       |
| POST   | `/auth/login`              | issue JWT                               |
| POST   | `/auth/logout`             | clear cookie                            |
| GET    | `/api/me`                  | current user + `{ used, quota }`        |
| GET    | `/api/files`               | list current user's files               |
| POST   | `/api/files`               | upload (multipart, field `file`)        |
| GET    | `/api/files/:id`           | metadata for one file                   |
| GET    | `/api/files/:id/download`  | streams the file                        |
| DELETE | `/api/files/:id`           | delete file + decrement `storage_used`  |
| GET    | `/health`                  | liveness probe (no auth)                |

Cross-user access on any `/api/files/:id*` returns **404**, not 403, so
the API does not leak existence of other users' files.

---

## Security

Three layers of defense against IDOR / path traversal — all required:

**A. Authorization on every file row lookup.**

```js
const file = await db.file.findFirst({
  where: { id: req.params.id, userId: req.user.id },   // BOTH
});
if (!file) return res.sendStatus(404);
```

**B. Path containment.** `server/src/lib/storage.js`:

```js
export function safeUserPath(userId, storedName) {
  const root = userDir(userId);
  const full = path.resolve(root, storedName);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error('path traversal blocked');
  }
  return full;
}
```

**C. Filename hygiene.**

- Stored filenames are random UUIDs — the user's name is metadata only.
- `originalName` is sanitized before being stored:
  `name.replace(/[\x00-\x1f<>:"/\\|?*]/g, '_')`.
- Downloads always set `Content-Disposition: attachment; filename*=UTF-8''…`
  so browsers do not render uploaded HTML/SVG inline (XSS prevention).

**Other hardening:**

- bcrypt cost 12.
- JWT in httpOnly + Secure (in prod) + SameSite=Lax cookie.
- `helmet()` for security headers.
- `express-rate-limit`: 30 req/min on `/auth/*`, 240 req/min on `/api/*`.
- multer hard cap: 5 GB per single upload.
- CORS allow-list (`CORS_ORIGINS` env var).

---

## Quota enforcement

The naive "check then write" pattern has a TOCTOU race. We do the check
inside a transaction:

```js
await db.$transaction(async (tx) => {
  const u = await tx.user.findUnique({
    where: { id: userId },
    select: { storageUsed: true, storageQuota: true },
  });
  if (u.storageUsed + size > u.storageQuota) {
    const e = new Error('quota'); e.status = 413; throw e;
  }
  await tx.file.create({ data: { ... } });
  await tx.user.update({
    where: { id: userId },
    data: { storageUsed: { increment: size } },
  });
});
```

Multipart upload flow:

1. `multer.diskStorage` streams the request body to `.tmp-<uuid>`
   inside the user's directory.
2. After the stream ends, we know the real size (from `req.file.size`).
3. The transaction above runs.
4. On success → `fs.rename` the temp file to its final UUID name.
5. On failure → `fs.unlink` the temp file. The DB transaction has
   already rolled back, so `storage_used` is untouched.

Tested in `server/src/api.test.js` (the "quota enforcement" case).

---

## What's deliberately deferred

| Feature                  | Why deferred                      | When to add                                   |
|--------------------------|-----------------------------------|-----------------------------------------------|
| Encryption at rest       | Adds key-mgmt complexity          | Before storing sensitive data — use LUKS      |
| Email verification       | No SMTP yet                       | When you wire up an email provider            |
| Password reset           | Same as above                     | Same                                          |
| Folders / nested paths   | YAGNI for v1                      | When users actually need them                 |
| Sharing links            | Not requested                     | Add a `share_links(file_id, expires_at)` table|
| Resumable uploads        | Browsers handle <5 GB fine        | If you add multi-GB workloads — use tus       |
| Antivirus scanning       | Internal tool, low risk           | If you ever accept untrusted uploads          |
| Audit log                | Nice-to-have                      | Add an `events` table; cheap insurance        |
| Postgres                 | SQLite is enough for one PC       | When you run >1 instance                      |

---

## File-tree reference

```
server/
├── package.json
├── .env.example
├── eslint.config.js
├── prisma/
│   ├── schema.prisma
│   └── migrations/
└── src/
    ├── index.js               ← Express bootstrap, middleware, listen
    ├── config.js              ← env vars, paths
    ├── db.js                  ← Prisma client
    ├── api.test.js            ← node:test integration suite
    ├── lib/
    │   └── storage.js         ← userDir / safeUserPath / sanitizeFilename
    ├── middleware/
    │   ├── auth.js            ← requireAuth (JWT)
    │   └── errors.js          ← notFound + central error handler
    └── routes/
        ├── auth.js            ← /auth/{register,login,logout}
        └── files.js           ← /api/{me,files,files/:id,...}

web/
├── package.json
├── vite.config.ts             ← proxies /api and /auth to :8080 in dev
├── eslint.config.js
├── tsconfig*.json
├── index.html
└── src/
    ├── main.tsx
    ├── App.tsx                ← top-level shell, auth state
    ├── api.ts                 ← typed fetch wrapper + upload via XHR
    ├── styles.css             ← AMOLED-friendly dark theme
    └── components/
        ├── AuthForm.tsx       ← login + register
        └── Dashboard.tsx      ← quota bar + file table + upload
```
