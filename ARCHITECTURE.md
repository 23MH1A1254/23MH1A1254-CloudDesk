# CloudDesk architecture

## 1. System overview

```
┌──────────────────────────────┐
│  Browser (React 18 + Vite)   │
│  Router · Context · Recharts │
└──────────────┬───────────────┘
               │ HTTPS/JSON, Bearer JWT
┌──────────────▼───────────────┐
│  Express REST API (Node 20)  │
│  helmet · cors · rate-limit  │
│  zod validation · pino logs  │
│  controllers → services      │
└───┬───────────┬───────────┬──┘
    │           │           │
    │Prisma     │AI         │Storage
┌───▼─────┐ ┌───▼────────┐ ┌▼──────────────┐
│Postgres │ │Gemini +    │ │Local disk or  │
│         │ │fallback    │ │S3 (optional)  │
└─────────┘ └────────────┘ └───────────────┘
```

Every layer is replaceable: the storage driver is chosen at call time, the AI service has a
pure-JavaScript fallback, and the database is reached only through Prisma.

## 2. Frontend

- **React 18 + Vite** with JavaScript (no TypeScript) and React Router 6.
- **State** lives in four contexts rather than a store library:
  - `ThemeContext` — light/dark, persisted in `localStorage`, applied before first paint by a
    small inline script in `index.html` to avoid a flash of the wrong theme.
  - `AuthContext` — token bootstrap, login/register/logout, role helpers (`isCustomer`,
    `isAgent`, `isAdmin`, `isStaff`).
  - `ToastContext` — transient feedback.
  - `NotificationContext` — unread badge, polled every 45 s while authenticated.
- **API layer** (`src/api/`) is a single axios instance that injects the JWT, normalises every
  error into `{ message, status, details }`, and clears the session on a 401.
- **Routing** — `ProtectedRoute` guards the authenticated shell; `roles` narrows admin routes;
  `PublicOnlyRoute` keeps signed-in users off login/register. `/dashboard` renders a different
  dashboard per role through `DashboardRouter`.
- **Styling** — one hand-written CSS design system driven by custom properties. Dark mode is a
  `data-theme` attribute swap; no CSS framework, no runtime style engine.
- **Charts** — Recharts, fed exclusively by `/api/tickets/stats` and `/api/admin/analytics`.
  Each chart renders an explicit empty state rather than fabricating data.

## 3. Backend

Layering is strict and one-directional:

```
routes → middleware (auth, validate, rateLimit, upload) → controllers → services → prisma
```

- **Controllers** are thin: unwrap the request, call a service, shape the response envelope.
  All are wrapped in `asyncHandler` so rejected promises reach the error middleware.
- **Services** hold the business rules: access scoping, status transitions, notifications,
  audit records, statistics aggregation.
- **Middleware**
  - `auth.authenticate` verifies the JWT and loads a fresh user (so deactivated accounts lose
    access immediately); `auth.authorize(...roles)` enforces role checks.
  - `validate({ body, query, params })` parses with Zod and replaces the originals with the
    coerced values; failures become `400` with per-field details.
  - `upload` uses Multer in memory storage with MIME **and** extension checks plus a size cap.
  - `error` maps Prisma codes (`P2002` → 409, `P2025` → 404, `P2003` → 400), hides stacks in
    production, and logs everything through Pino.
- **Security** — bcrypt hashing (configurable rounds), Helmet headers, a CORS allowlist rather
  than `*`, layered rate limits, redaction of `authorization`/`password` in logs, and a boot
  guard that refuses to start in production without `JWT_SECRET`.

## 4. Database (PostgreSQL + Prisma)

Models: `User`, `Category`, `Ticket`, `TicketMessage`, `Attachment`, `Notification`,
`AuditLog`, `AIAnalysis`. Enums: `Role`, `TicketStatus`, `Priority`, `Sentiment`,
`NotificationType`, `AuditAction`, `AnalysisSource`.

Design notes:

- Tickets carry a human-friendly `reference` (`CD-XXXXXX`) alongside the UUID primary key.
- Lifecycle timestamps (`firstResponseAt`, `resolvedAt`, `closedAt`) make response-time and
  resolution metrics real aggregations rather than guesses.
- `TicketMessage.isInternal` is the single source of truth for agent-only notes.
- `AIAnalysis` is append-only: every run is stored with its `source`, `model` and `available`
  flag, so the history of what the model said is preserved.
- `AuditLog.actorId` uses `onDelete: SetNull` so deleting a user never erases the trail.
- Indexes cover the real query paths: ticket status/priority/customer/assignee/category,
  notification `(userId, isRead)`, audit `action`/`actorId`/`createdAt`.

Tables are mapped to snake_case via `@@map` so the schema reads naturally from psql.

## 5. AI subsystem

`services/ai/` has three parts:

1. **`analysis.schema.js`** — the Zod contract every analysis must satisfy before it leaves
   the backend.
2. **`gemini.service.js`** — loads the SDK lazily, builds a strict JSON-only prompt from the
   ticket title, description, category, priority and non-internal conversation, races the call
   against `AI_TIMEOUT_MS`, extracts JSON from fenced or prose-wrapped responses, and coerces
   loose values (e.g. `"high"` → `HIGH`) into the enum vocabulary.
3. **`fallback.js`** — a deterministic keyword analyser: category and priority rules, sentiment
   detection, missing-information heuristics and response templates.

`analyzeTicket()` **never throws**. It returns
`{ analysis, source: 'GEMINI' | 'FALLBACK', model, available, error }`, so the API always has a
usable payload and the UI can be explicit about which engine produced it.

## 6. Storage

`services/storage/index.js` picks a driver per call (not at import time), so configuration can
change without a restart of the module graph:

- **local** — writes to `UPLOAD_DIR` with sanitised, randomised filenames and a path-traversal
  guard; served read-only from `/uploads`.
- **s3** — activates only when `STORAGE_DRIVER=s3` and all AWS variables are present. Uploads
  use SSE-AES256 and downloads use presigned URLs. If the configuration is incomplete the
  service logs a warning and falls back to local rather than failing uploads.

## 7. Notifications and audit

Notifications are written by the ticket service on creation, reply, status change, assignment
and completed analysis, then polled by the client. Audit entries are written for logins,
registrations, user CRUD, ticket CRUD, assignment, status change, messages, uploads, AI runs
and category CRUD. Audit writes are best-effort: a failure is logged but never breaks the
request it was recording.

## 8. Testing and CI

Jest + Supertest cover the health endpoint, registration, login, authenticated access,
authorization boundaries, ticket creation and the AI fallback contract. Database-backed tests
detect an unreachable database and skip rather than fail, which keeps the suite runnable in
constrained environments. CI runs lint, `prisma validate`, `prisma migrate deploy`, backend
tests, the frontend production build and `docker compose config` — and never deploys.

## 9. Cloud-readiness

Nothing in the code assumes AWS. The seams that make an AWS deployment straightforward are:
the storage driver (→ S3), `DATABASE_URL` (→ RDS), the container images (→ ECS/EC2), the static
`client/dist` bundle (→ S3 + CloudFront), and structured stdout logging (→ CloudWatch).
See `AWS_DEPLOYMENT.md`.
