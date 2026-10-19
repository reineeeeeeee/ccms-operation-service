# ccms-operations-service (Transaction)

Part of the Citizen's Charter Compliance/Monitoring System (CCMS). One service = one repository = one database (`ccms_operations`).
This service owns **transactions**: start with a standard snapshot, hold/resume, complete with compliance, cancel, the role-scoped list,
auto-close, the settings and counters, and the receipt email. **API only**: every screen lives in `ccms-frontend`; the browser reaches this
service through `ccms-api-gateway` (`/api/operations/*` arrives here as `/api/*`).

Stack: Next.js Route Handlers (JavaScript) · TypeORM · PostgreSQL 15+ · `ccms-shared` (vendored). Same layout as `ccms-core-service`.

```
src/app/api/        routes (health, settings, counters, transactions, jobs/*)
src/modules/transaction/   settings, counters, start, hold, complete, compliance, cancel, list, auto-close, compute-pending, receipt, core-client
src/jobs/           outbox-dispatch, compute-pending, auto-close, receipt-emails
src/lib/            data-source, entities, after-sync (constraints), outbox, mailer
test/               node:test (needs PostgreSQL: TEST_PG_URL)
```

## Run

```bash
cp .env.example .env.local
npm install
npm run db:sync
npm run dev      # http://127.0.0.1:3004/api/health  ->  { "status": "UP" }
```

## Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL`, `DB_SYNCHRONIZE`, `DB_POOL_MAX` | own database `ccms_operations` |
| `IDENTITY_JWKS_URL`, `JWT_ISSUER`, `JWT_AUDIENCE` | token verification |
| `SERVICE_KEY` | shared service key (calls to Core) |
| `CORE_URL` | Core address, with or without `/api` |
| `LOGS_SERVICE_URL` | where audit events are delivered |
| `CRON_SECRET` | secret Vercel Cron sends to `/api/jobs/*` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | receipt email (CC024); empty host = nothing is sent |

## API (under `/api`)

| Route | Who |
| --- | --- |
| `GET /health` | anyone |
| `GET /settings`, `PUT /settings` | read: any role; change: Super Admin (version check, 409 `SETTINGS_VERSION_CONFLICT`) |
| `GET /counters?officeId=`, `POST /counters`, `PUT /counters/:id`, `PATCH /counters/:id/deactivate\|reactivate` | read: Super Admin, Office Head/Staff (own office); write: Super Admin |
| `POST /transactions`, `GET /transactions`, `GET /transactions/:id` | Super Admin, Office Head, Office Staff (scoped); Executive 403 |
| `POST /transactions/:id/hold`, `/resume`, `/complete` | who started it, Office Head of the office, Super Admin |
| `POST /transactions/:id/cancel` | Office Head (own office), Super Admin |
| `GET /jobs/outbox`, `/jobs/compute-pending`, `/jobs/auto-close`, `/jobs/receipt-emails` | `CRON_SECRET` only (not reachable through the gateway) |

Errors use `{ error: { code, message, details, correlation_id, timestamp } }`. Every change writes its audit event in the same
database transaction (outbox) and the outbox job delivers it.

## Notes

- Tables are created from the entities on start; constraints and partial unique indexes are in `src/lib/after-sync.js` (no migration files, E22 open).
- The standard, service, office and classification are copied onto the transaction at the start; Charter changes never change past results.
- Cron schedules in `vercel.json` are once a day (E20 open).
- `src/lib/mailer.js` is a small SMTP client written because Identity's mailer was not available; replace it with the shared mailer when it exists (only `send({ to, subject, text })` is used).
