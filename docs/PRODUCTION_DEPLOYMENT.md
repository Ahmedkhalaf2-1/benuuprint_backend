# Production deployment (VPS)

Backend production runbook for Benue Print. Local development is unchanged and fully separate (see `.env.example`).

## Architecture

| Component  | Bind address       | Public URL                                    |
| ---------- | ------------------ | --------------------------------------------- |
| Frontend   | `127.0.0.1:3021`   | https://benuuprint.com, https://www.benuuprint.com |
| Backend    | `127.0.0.1:3020`   | https://api.benuuprint.com                    |
| PostgreSQL | `127.0.0.1:5545`   | none (private)                                |

- Reverse proxy / TLS: **Caddy**. Process manager: **PM2**. Runtime: **Node.js 22**, **pnpm**. PostgreSQL 16 in Docker.
- Intended routing (configured on the VPS, not from this repo; this repo never touches DNS or `/etc/caddy/Caddyfile`):
  - `benuuprint.com`, `www.benuuprint.com` -> `127.0.0.1:3021`
  - `api.benuuprint.com` -> `127.0.0.1:3020`
- The backend listens on the internal port only; do not open 3020/3021/5545 in the firewall.
- **PostgreSQL must never be exposed to the internet.** Publish it as `127.0.0.1:5545:5432` only.

## Coexistence with Contrast

This VPS also hosts Contrast: frontend `3000`, backend `3010`, PostgreSQL `5544`. Benue Print must keep to
`3021` / `3020` / `5545` and must never reuse `3000`, `3010` or `5544`.

## Server `.env`

The production `.env` lives **only on the VPS** (`/opt/benue-print/backend/.env`, mode `600`). Never commit it, and never
commit JWT secrets or passwords. The app reads `.env` from its working directory (the PM2 config sets `cwd`).
Real environment variables take precedence over `.env`.

```dotenv
NODE_ENV=production
PORT=3020
API_PORT=3020
LOG_LEVEL=info
CORS_ORIGINS=https://benuuprint.com,https://www.benuuprint.com
PUBLIC_APP_URL=https://benuuprint.com
TRUST_PROXY=true
SWAGGER_ENABLED=false
RATE_LIMIT_ENABLED=true

DATABASE_URL=postgresql://benue:<DB_PASSWORD>@127.0.0.1:5545/benue_print?schema=public
POSTGRES_PORT=5545

JWT_ACCESS_SECRET=<openssl rand -base64 48>
JWT_CUSTOMER_SECRET=<a different openssl rand -base64 48>   # keep staff and customer keys separate

STORAGE_PROVIDER=local
STORAGE_LOCAL_ROOT=/opt/benue-print/storage

BUSINESS_TIMEZONE=Africa/Cairo
CUSTOMER_EMAIL_VERIFICATION_REQUIRED=false   # temporary: no email infrastructure yet
EMAIL_PROVIDER=disabled
WHATSAPP_PROVIDER=disabled
EXPOSE_ONE_TIME_TOKENS=false
SCHEDULER_ENABLED=true
```

Notes:

- **CORS**: `CORS_ORIGINS` is comma-separated; a `*` is rejected at startup in production.
- **Proxy**: `TRUST_PROXY=true` trusts exactly one hop (Caddy), so `req.ip` (used for rate limiting and audit) is the real
  client IP taken from `X-Forwarded-For`. Without it every user would share the proxy IP. Caddy sets that header by default.
  Never expose the backend port directly when this is on.
- **Public links** (invitations, verification, tracking, QR codes) are built from `PUBLIC_APP_URL`, not from request hosts.
- **Verification**: when ready for email, set `CUSTOMER_EMAIL_VERIFICATION_REQUIRED=true` and configure a provider; no code
  change is needed. Activation/verification endpoints stay available.
- **Notifications**: with providers `disabled`, deliveries are skipped/failed as permanent errors; the scheduler and API keep running.
- **Staff vs customer tokens** use different audiences and different signing keys. Set `JWT_CUSTOMER_SECRET` explicitly.
- **Scheduler** runs in-process; run exactly one backend instance (the PM2 config uses fork mode, `instances: 1`).
  Intervals: `SCHEDULER_OUTBOX_INTERVAL_SECONDS`, `SCHEDULER_DISPATCH_INTERVAL_SECONDS`, `SCHEDULER_ALERTS_INTERVAL_SECONDS`.
- `API_PORT` is only used by `docker-compose.yml` (`--profile app`); the PM2 deployment uses `PORT`.

## Storage

`STORAGE_PROVIDER=local` stays. Files are private and served only via short-lived signed URLs. A relative root such as
`./storage` resolves against the process working directory, so use an **absolute persistent path outside the repo and
`dist/`**, e.g. `/opt/benue-print/storage`:

```bash
sudo mkdir -p /opt/benue-print/storage
sudo chown <app-user>: /opt/benue-print/storage && sudo chmod 700 /opt/benue-print/storage
```

Rebuilds and redeploys never touch it. **Back it up together with the database.** If the server previously used
`./storage` inside the repo, move its contents to the new path (`rsync -a`) before switching `STORAGE_LOCAL_ROOT`.

## Deploy sequence

```bash
cd /opt/benue-print/backend
git pull
pnpm install --frozen-lockfile
pnpm prisma generate
pnpm prisma migrate deploy      # back up the DB first when the release contains migrations
pnpm build
pm2 restart benue-backend --update-env
curl http://127.0.0.1:3020/api/v1/health
```

First start (or after `pm2 delete`): `pm2 start ecosystem.config.cjs --env production && pm2 save`.
Enable boot persistence once with `pm2 startup`. The equivalent manual command is `pm2 start dist/main.js --name benue-backend`
(run it from the backend directory so `.env` is found); the ecosystem file is preferred.

The health response contains only `status`, `timestamp`, `uptimeSeconds` and `api`/`database` up/down (no secrets).

## Database and Prisma

- Production uses `pnpm prisma generate` and `pnpm prisma migrate deploy` only.
- **Never** run `prisma migrate dev`, `prisma migrate reset`, `prisma db push`, or `pnpm db:seed` against production, and do
  not edit historical migrations. Nothing in app startup migrates, seeds or resets.
- **Back up before schema migrations**, and run `migrate deploy` before restarting the app when a release includes migrations:

```bash
docker exec <postgres-container> pg_dump -U benue -Fc benue_print > /opt/benue-print/backups/benue_print_$(date +%F_%H%M).dump
```

- The production database must never be used for automated tests (`pnpm test:e2e` needs its own disposable database).

## Logging

`LOG_LEVEL=info`. Authorization and cookie headers are redacted, public tracking tokens are masked in request URLs, and
secrets/refresh tokens/DB credentials are not logged. Use `pm2 logs benue-backend`; configure `pm2 install pm2-logrotate`.

## Manual steps on the VPS

1. DNS records for `benuuprint.com`, `www`, and `api` (outside this repo).
2. Caddy site blocks and TLS (outside this repo).
3. Create the server `.env` and the storage directory.
4. `pm2 start ecosystem.config.cjs --env production`, `pm2 save`, `pm2 startup`.
