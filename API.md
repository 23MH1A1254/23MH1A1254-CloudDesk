# CloudDesk API reference

Base URL (local): `http://localhost:5000/api`
Health endpoint lives outside the prefix: `http://localhost:5000/health`

## Conventions

Every response uses a consistent envelope:

```json
{ "success": true, "message": "Optional human message", "data": {}, "meta": {} }
```

Errors:

```json
{
  "success": false,
  "message": "Validation failed",
  "details": [{ "field": "email", "message": "Enter a valid email address" }]
}
```

| Status | Meaning |
| --- | --- |
| 400 | Validation failed / bad input |
| 401 | Missing or invalid JWT |
| 403 | Authenticated but not allowed |
| 404 | Not found |
| 409 | Conflict (e.g. duplicate email) |
| 413 | Upload too large |
| 429 | Rate limited |
| 500 | Unexpected server error |

## Authentication

Send the JWT returned by register/login on every protected call:

```
Authorization: Bearer <token>
```

Roles: `CUSTOMER`, `SUPPORT_AGENT`, `ADMIN`. Customers are scoped to their own tickets;
agents and admins see all tickets; admin-only routes live under `/api/admin`.

---

## Health

### `GET /health`

```json
{
  "status": "ok",
  "service": "clouddesk-api",
  "version": "1.0.0",
  "environment": "development",
  "uptime": 42,
  "timestamp": "2026-01-01T10:00:00.000Z",
  "dependencies": { "database": "up", "ai": "fallback", "storage": "local" }
}
```

Always returns `200` so the endpoint stays usable as a liveness probe; `dependencies.database`
reports `"down"` when PostgreSQL cannot be reached.

### `GET /api`

Reports API version plus whether Gemini and S3 are configured.

---

## Auth

### `POST /api/auth/register`

Public. New accounts are always created as `CUSTOMER` — role escalation is admin-only.

```json
{ "name": "Asha Rao", "email": "asha@example.com", "password": "Passw0rd!" }
```

```json
{
  "success": true,
  "message": "Account created",
  "data": {
    "token": "eyJhbGciOi...",
    "user": { "id": "uuid", "name": "Asha Rao", "email": "asha@example.com", "role": "CUSTOMER" }
  }
}
```

### `POST /api/auth/login`

```json
{ "email": "agent@clouddesk.dev", "password": "Agent@123" }
```

Returns the same `{ token, user }` payload. Invalid email and invalid password return the
same generic 401 so accounts cannot be enumerated.

### `GET /api/auth/me`

Returns the current user. Requires a token.

### `PATCH /api/auth/me`

Body: `{ "name": "...", "avatarUrl": "...", "currentPassword": "...", "newPassword": "..." }`
(all optional; `newPassword` requires `currentPassword`).

---

## Tickets

All ticket routes require authentication.

### `GET /api/tickets`

Query parameters: `page`, `limit`, `status`, `priority`, `categoryId`, `assigneeId`,
`customerId`, `scope` (`all|mine|unassigned`), `search`, `sortBy`, `sortOrder`.

```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "reference": "CD-SEED01",
      "title": "Payment deducted but order shows Payment Failed",
      "status": "OPEN",
      "priority": "URGENT",
      "category": { "id": "uuid", "name": "Billing", "color": "#f59e0b" },
      "customer": { "id": "uuid", "name": "Dev Customer", "role": "CUSTOMER" },
      "assignee": null,
      "_count": { "messages": 2, "attachments": 0 },
      "createdAt": "2026-01-01T09:00:00.000Z"
    }
  ],
  "meta": { "total": 5, "page": 1, "limit": 10, "totalPages": 1, "hasNext": false, "hasPrev": false }
}
```

### `GET /api/tickets/stats`

Dashboard cards and chart series, scoped to the caller's role.

### `GET /api/tickets/:id`

Full ticket with `messages`, `attachments` and the latest `aiAnalyses` entry.
Customers never receive messages flagged `isInternal`.

### `POST /api/tickets`

```json
{
  "title": "Payment deducted but order shows Payment Failed",
  "description": "I paid ₹64,999 for a laptop. The amount left my account but the order page says Payment Failed.",
  "priority": "HIGH",
  "categoryId": "uuid-or-omitted"
}
```

`201` with the created ticket, including its generated `reference` (`CD-XXXXXX`).

### `PATCH /api/tickets/:id`

Body may contain `title`, `status`, `priority`, `categoryId`, `assigneeId`, `satisfaction`.
Customers may only rate their own resolved tickets; status/priority/assignment are staff-only.
Status changes to `RESOLVED`/`CLOSED` stamp `resolvedAt`/`closedAt` and notify the customer.

### `DELETE /api/tickets/:id`

Admin only. Cascades to messages, attachments and analyses.

### `POST /api/tickets/:id/messages`

```json
{ "body": "Could you share the transaction reference?", "isInternal": false }
```

`isInternal: true` is honoured for staff only and is hidden from customers. The first staff
reply stamps `firstResponseAt`, which feeds the average-response-time metric.

### `POST /api/tickets/:id/attachments`

`multipart/form-data` with a single `file` field. PNG, JPG/JPEG and PDF only, size capped by
`MAX_UPLOAD_SIZE_MB` (default 5 MB). Filenames are sanitised and randomised.

```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "originalName": "receipt.pdf",
    "mimeType": "application/pdf",
    "size": 81234,
    "storage": "local",
    "url": "/uploads/1735-xyz-receipt.pdf"
  }
}
```

### `POST /api/tickets/:id/analyze`

Runs AI analysis (rate limited). Always succeeds:

```json
{
  "success": true,
  "message": "AI analysis completed",
  "data": {
    "summary": "Customer was charged for a laptop order that still displays as failed.",
    "category": "Billing",
    "priority": "URGENT",
    "sentiment": "FRUSTRATED",
    "missingInformation": ["Transaction/UTR reference", "Order ID"],
    "suggestedResponse": "Thanks for flagging this...",
    "recommendedAction": "Verify the payment with the gateway and reconcile the order.",
    "source": "GEMINI",
    "model": "gemini-1.5-flash",
    "available": true
  }
}
```

When Gemini is not configured, errors or times out, `source` is `FALLBACK` and
`available` is `false` — the frontend renders a clear "AI unavailable" banner.

### `GET /api/tickets/:id/analysis`

Latest stored analysis, or `null`.

---

## Notifications

- `GET /api/notifications` — paginated; `meta.unreadCount` included.
- `GET /api/notifications/unread-count`
- `PATCH /api/notifications/:id/read`
- `PATCH /api/notifications/read-all`

Notifications are created for ticket creation, replies, status changes, assignment and
completed AI analysis.

---

## Categories

- `GET /api/categories` — active categories, available to any signed-in user.

---

## Admin

`GET /api/admin/agents` is available to agents and admins. Everything else requires `ADMIN`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/admin/users` | Paginated users (`role`, `isActive`, `search`) |
| POST | `/api/admin/users` | Create a user with any role |
| PATCH | `/api/admin/users/:id` | Update name, role, password, active flag |
| DELETE | `/api/admin/users/:id` | Delete a user (cannot delete yourself) |
| GET | `/api/admin/analytics` | Platform-wide cards, charts, agent workload, sentiment |
| GET | `/api/admin/system` | Record counts and API runtime information |
| GET | `/api/admin/audit-logs` | Paginated audit trail (`action`, `actorId`) |
| GET | `/api/admin/categories` | Categories (`includeInactive=true` for hidden ones) |
| POST | `/api/admin/categories` | Create a category |
| PATCH | `/api/admin/categories/:id` | Update name, description, colour, visibility |
| DELETE | `/api/admin/categories/:id` | Delete (tickets become uncategorised) |

---

## Rate limits

| Scope | Default |
| --- | --- |
| All `/api` routes | 300 requests / 15 min |
| `/api/auth/register`, `/api/auth/login` | 20 requests / 15 min |
| `POST /api/tickets/:id/analyze` | 10 requests / minute |

Limits are disabled in the test environment.

---

## Quick curl walkthrough

```bash
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"agent@clouddesk.dev","password":"Agent@123"}' | jq -r .data.token)

curl -s http://localhost:5000/api/tickets -H "Authorization: Bearer $TOKEN" | jq
```
