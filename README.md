# GetVirtu (getvirtu.shop)

Digital-goods shop (accounts, licence keys, digital services) with a customer balance, Mobile Money
(SasPay) top-ups, automatic key delivery and an administration dashboard. The Trybit crypto gateway was retired
on 2026-11-16 (its former routes answer 410 Gone).

- Storefront: `index.html` + `app.js` · Admin dashboard: `admin.html` (`/admin`)
- API (Vercel serverless functions): `api/auth.js`, `api/data.js`, `api/payments.js`
- Server logic: `backend/` (`db.js` data model, `store.js` storage adapters, `auth.js`, `payments.js`)
- Local server: `node server.js` (same handlers as production)

## Data storage

All shop data is one document written through a transactional adapter (`backend/store.js`):

| Where | Adapter | Guarantees |
|---|---|---|
| Production with `DATABASE_URL` / `POSTGRES_URL` | **Postgres** (schema `getvirtu`, RLS enabled) | Every write is a SQL transaction with a row lock: no lost update, no key sold twice. Images, payment proofs, visits and pre-reset backups are stored in their own tables. |
| Production without a database (temporary) | Vercel Edge Config | Works, but without cross-instance transactions. Create a Postgres database as soon as possible. |
| Local development / tests | `data/database.json` | Atomic file writes. A local process **never** writes to a remote database unless `GV_STORE=postgres` is set. |

When a Postgres database is attached for the first time, existing Edge Config data is imported automatically.

**Create the production database:** Vercel → project `virtushop` → Storage → Create Database (Neon or Supabase) →
connect it to the project (Production) → redeploy. The admin dashboard (System tab) shows which storage is active.

## Configuration

See `.env.example` for every variable. Required in production (as *Sensitive* variables): `SESSION_SECRET`,
`ADMIN_PASSWORD_HASH`, a database URL, and the payment provider keys you use.

- Generate an admin password hash: `npm run hash-password` (or `node scripts/hash-password.js --generate`).
- `ADMIN_PASSWORD_HASH` is applied once per distinct value: it sets the first password and is the
  **break-glass recovery** (set a new hash, redeploy, then log in with the new password).
  Password changes made in the dashboard are kept otherwise.
- No password, hash or secret is stored in the source code.

## Accounts

- Admin dashboard: `https://getvirtu.shop/admin` — identifier `admin` (or the admin e-mail) + the admin password.
  Change it in **Admin → System → Mot de passe administrateur**. Admin sessions expire after 12 hours.
- Customers register and log in from the storefront (`https://getvirtu.shop`, buttons *S'inscrire* / *Connexion*).
  Customer sessions last 30 days; a password change logs out every other device.
- Forgotten customer password: if `RESEND_API_KEY` + `MAIL_FROM` are set, customers receive a reset link by e-mail;
  otherwise they contact the support and the admin generates a one-time temporary password
  (**Admin → Clients & Soldes → 🔑 Mot de passe**); the customer must choose a new one at the next login.

## System Management / Reset Website

Admin → **Système** tab (also the *Système / Reset* button in the header). Only the main (owner) administrator can
reset. Each reset requires: the administrator password, the exact phrase `RESET WEBSITE`, and an explicit
acknowledgement. The server re-checks everything, takes a full backup first, and runs the reset as one atomic
operation (everything or nothing). The backup is also downloaded to the admin's device.

| | Option A — Demo Data Reset | Option B — Full Store Reset |
|---|---|---|
| Products, categories, prices, descriptions | deleted | deleted |
| Keys / stock, delivery files, product images | deleted | deleted |
| Customer accounts and balances | deleted | deleted |
| Orders, transactions, top-ups, payment proofs | deleted | deleted |
| Support tickets, visit statistics, customer sessions | deleted | deleted |
| Payment methods (and their QR codes) | **kept** | reset to the default gateway (SasPay Mobile Money) |
| Shop settings (minimum top-up, WhatsApp number) | **kept** | reset to defaults |
| Other administrators' sessions | kept | revoked |
| Owner administrator account and password | **kept** | **kept** |
| Environment variables, API keys, database structure, security configuration, application code | **kept** | **kept** |

Server-side backups: Postgres table `getvirtu.backups` (15 most recent) or `data/backups/` locally.
On the Edge Config fallback, the downloaded file is the only backup.

## Security model (summary)

- Authorization is enforced by the server on every endpoint; the browser never decides who is admin.
- Sessions are HMAC-signed tokens bound to the account (`session_version`) and revocable (logout, password change, reset).
- Prices, totals, stock and balances are computed on the server; client-supplied ids, prices and roles are ignored.
- A payment is credited only after a server-to-server check with SasPay using the provider id stored when
  the payment was created (webhooks are only triggers); crediting is idempotent.

## Mobile Money (SasPay) lifecycle

1. `POST /api/payments/saspay/create` validates the number for the chosen country (leading 0 kept in Côte d'Ivoire,
   Bénin, Congo), the operator and its OTP, then calls SasPay softpay with an `Idempotency-Key` (one safe retry).
   Answer: `mode` `push` (request on the phone, operator-specific steps, ~3 min to validate), `redirect` /
   `checkout` (`checkoutUrl` to open: Wave, Orange CI, hosted page — expires after 30 min) — never a silent fallback.
2. The browser polls `GET /api/payments/saspay/verify` (tracking kept in `localStorage`, resumed after a reload or
   on return from the hosted page via `?momo_return=`). The server asks SasPay for the real status:
   `SUCCESS` → balance credited once (amount/currency checked) and, when the payment was started from a product,
   the order is placed server-side (`metadata.purchase`); `FAILED` → reason from SasPay `status_logs` shown to
   the customer with what to do; refusals at creation are mapped to clear messages.
3. Nothing stays blocked: SasPay webhooks (`POST /api/payments/webhook`, HMAC on the raw body when
   `SASPAY_WEBHOOK_SECRET` is set), the customer history, the admin dashboard and a daily Vercel cron
   (`/api/payments/saspay/reconcile`) re-check pending payments; after 72 h without answer a payment is closed.
4. Admin › Système › « Mobile Money (SasPay) — diagnostic » checks the API key, active operators, webhook setup
   and the last notifications; each pending recharge has a « Vérifier SasPay » button.
- Uploads: real PNG/JPEG/WebP/GIF only (magic-number check, no SVG), size limits, stored outside the main document.
- Strict security headers (CSP without `unsafe-eval`, HSTS, frame and MIME protections); private paths are never served.

## Development

```bash
npm install
cp .env.example .env        # local values only
npm start                   # http://localhost:3000  (admin: /admin)
npm test                    # API end-to-end (file store + mocked Edge Config), migration, static checks
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/disposable_db npm test   # + Postgres suites
npm run test:browser        # Chromium journeys on desktop, tablet and mobile (needs Playwright)
```

Tests always run on a temporary database and never read `.env`.

## Deployment

- `npm run deploy` — production deployment of an explicit whitelist of files (version stamped automatically).
- `npm run deploy:preview` — preview deployment.
- Recommended: connect the Vercel project to this GitHub repository (Vercel → Settings → Git) so that every push to
  `main` deploys automatically.
