# CloudDesk

**Smart Customer Support, Built for the Cloud.**

CloudDesk is a full-stack customer-support SaaS application: customers raise tickets,
support agents triage and resolve them with AI assistance, and administrators manage
users, categories, analytics and an audit trail.

The whole application runs locally with Docker + PostgreSQL. AWS is **optional** and
documented in [`docs/AWS_DEPLOYMENT.md`](docs/AWS_DEPLOYMENT.md) — nothing in this repo
creates cloud resources.

---

## Features

**Customers** — register/login, create tickets with attachments, follow the conversation,
rate resolutions, see notifications.

**Support agents** — filtered ticket queues, assignment, status/priority/category control,
internal notes invisible to customers, AI analysis, live dashboard stats.

**Administrators** — everything agents can do, plus user management, category management,
platform analytics, system statistics and an append-only audit log.

**AI (Google Gemini)** — summary, category, priority, sentiment, missing information,
suggested response and recommended action. Validated with Zod before it reaches the UI.
If no `GEMINI_API_KEY` is set, or Gemini errors or times out, CloudDesk falls back to a
deterministic rule-based analyser and the UI clearly marks the result as unavailable.
**The application never crashes because of AI.**

**Platform** — JWT auth with bcrypt hashing, role-based authorization, Zod validation,
Helmet, CORS allowlist, rate limiting, Pino structured logging, centralised error handling,
MIME + size validated uploads, light/dark mode, responsive SaaS UI.

---

## Architecture at a glance

```
React (Vite) ──HTTP/JSON──► Express REST API ──Prisma──► PostgreSQL
                                   │
                                   ├──► Gemini service (with deterministic fallback)
                                   └──► Storage service (local disk, or S3 when configured)
```

Full detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Endpoint reference: [`docs/API.md`](docs/API.md).

---

## Project structure

```
CloudDesk/
├── client/                 React + Vite frontend
│   ├── src/api/            axios client and endpoint wrappers
│   ├── src/components/     layout, ui, charts, ticket components
│   ├── src/context/        auth, theme, toast, notifications
│   ├── src/pages/          public, customer, agent, admin pages
│   └── src/styles/         design system (light + dark)
├── server/                 Express + Prisma backend
│   ├── prisma/             schema, migration, seed
│   └── src/                config, middleware, routes, controllers, services, validation
├── docs/                   API, architecture, AWS deployment
├── .github/workflows/      CI (lint, prisma, tests, build)
└── docker-compose.yml      PostgreSQL + API + web
```

---

## Prerequisites

- **Node.js 20+** and npm
- **Docker Desktop** (for PostgreSQL — or a local PostgreSQL 14+ install)
- Optional: a **Google Gemini API key** from Google AI Studio

---

## Installation (Windows PowerShell)

```powershell
cd CloudDesk

# 1. Start PostgreSQL
docker compose up -d db

# 2. Backend
cd server
Copy-Item ..\.env.example .env
npm install
npx prisma generate
npx prisma migrate deploy
npm run seed
cd ..

# 3. Frontend
cd client
Copy-Item .env.example .env
npm install
cd ..
```

Generate a real JWT secret and paste it into `server/.env`:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

macOS/Linux users: replace `Copy-Item` with `cp`.

---

## Running the app

Two terminals:

```powershell
# Terminal 1 - API on http://localhost:5000
cd server
npm run dev
```

```powershell
# Terminal 2 - web app on http://localhost:5173
cd client
npm run dev
```

| Service        | URL                            |
| -------------- | ------------------------------ |
| Frontend       | http://localhost:5173          |
| API            | http://localhost:5000/api      |
| Health check   | http://localhost:5000/health   |

---

## Environment variables

Backend (`server/.env`):

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | PostgreSQL connection string |
| `JWT_SECRET` | yes | Long random string; the server refuses to boot in production without one |
| `PORT` | no | Defaults to `5000` |
| `CLIENT_ORIGIN` | no | CORS allowlist, defaults to `http://localhost:5173` |
| `JWT_EXPIRES_IN` | no | Defaults to `7d` |
| `BCRYPT_SALT_ROUNDS` | no | Defaults to `10` |
| `GEMINI_API_KEY` | no | Empty = deterministic fallback analyser |
| `GEMINI_MODEL` | no | Defaults to `gemini-1.5-flash` |
| `AI_TIMEOUT_MS` | no | Defaults to `20000` |
| `STORAGE_DRIVER` | no | `local` (default) or `s3` |
| `UPLOAD_DIR`, `MAX_UPLOAD_SIZE_MB` | no | Local storage settings |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_S3_BUCKET` | no | Only when `STORAGE_DRIVER=s3` |
| `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_MAX` | no | Rate limiting |
| `LOG_LEVEL` | no | Pino level |

Frontend (`client/.env`): `VITE_API_BASE_URL=http://localhost:5000/api`

Never commit a real `.env` — `.gitignore` already excludes it.

---

## Database

```powershell
cd server
npx prisma migrate dev      # create/apply migrations in development
npx prisma migrate deploy   # apply existing migrations (CI/production)
npm run seed                # idempotent seed data
npm run db:reset            # drop, re-migrate and re-seed
npx prisma studio           # browse data
```

### Development seed credentials

> ⚠️ Development only. Delete or change these before any real deployment.

| Role | Email | Password |
| --- | --- | --- |
| Customer | `customer@clouddesk.dev` | `Customer@123` |
| Customer | `customer2@clouddesk.dev` | `Customer@123` |
| Support agent | `agent@clouddesk.dev` | `Agent@123` |
| Admin | `admin@clouddesk.dev` | `Admin@123` |

The seed also creates five categories and five sample tickets with conversations.

---

## Docker

Run the whole stack (PostgreSQL + API + nginx-served frontend):

```powershell
docker compose up --build
```

- Web app: http://localhost:8080
- API: http://localhost:5000
- PostgreSQL: `localhost:5432`

The API container runs `prisma migrate deploy` on boot. To seed inside Docker:

```powershell
docker compose exec server npm run seed
```

Stop and remove volumes with `docker compose down -v`.

---

## Testing and linting

```powershell
cd server
npm test          # Jest + Supertest: health, register, login, auth, tickets, authorization, AI fallback
npm run lint

cd ..\client
npm run lint
npm run build     # production build check
```

Database-backed backend tests skip themselves automatically when no PostgreSQL is
reachable, so `npm test` is safe to run anywhere; start the database first for full coverage.

---

## Deployment overview

CloudDesk is deployment-ready but deliberately cloud-agnostic:

1. Build the frontend (`npm run build`) and serve `client/dist` from any static host or CDN.
2. Run the API container anywhere that can reach PostgreSQL.
3. Point `DATABASE_URL` at a managed PostgreSQL instance.
4. Set `STORAGE_DRIVER=s3` plus the AWS variables to move attachments off local disk.

Step-by-step AWS guidance (S3, RDS, EC2/ECS, CloudFront, IAM, CloudWatch, cost notes)
lives in [`docs/AWS_DEPLOYMENT.md`](docs/AWS_DEPLOYMENT.md).

---

## License

MIT — built as a portfolio/learning project.
