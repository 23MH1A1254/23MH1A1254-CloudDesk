# Deploying CloudDesk on AWS

> **Nothing in this repository creates AWS resources.** This is a manual runbook for when you
> choose to deploy. CloudDesk runs completely locally without any AWS account.

## Target architecture

```
              ┌──────────────┐
  Users ────► │ CloudFront   │  (HTTPS, caching, custom domain)
              └──────┬───────┘
         static      │            /api/*
      ┌──────────────┴──────────────┐
      ▼                             ▼
┌─────────────┐             ┌──────────────────┐
│ S3 (web)    │             │ ALB → ECS Fargate│  CloudDesk API
│ client/dist │             │ (or a single EC2)│
└─────────────┘             └────────┬─────────┘
                                     │
                     ┌───────────────┼───────────────┐
                     ▼               ▼               ▼
              ┌────────────┐  ┌─────────────┐ ┌─────────────┐
              │ RDS        │  │ S3 (uploads)│ │ CloudWatch  │
              │ PostgreSQL │  │ attachments │ │ logs+alarms │
              └────────────┘  └─────────────┘ └─────────────┘
                     ▲
              Secrets Manager / SSM Parameter Store (JWT_SECRET, GEMINI_API_KEY)
```

---

## 1. S3 — attachments

1. Create a private bucket, e.g. `clouddesk-uploads-<account-id>`.
2. Block **all** public access. CloudDesk serves files through presigned URLs.
3. Enable default encryption (SSE-S3 or SSE-KMS) and versioning.
4. Optional lifecycle rule: transition objects older than 90 days to Infrequent Access.
5. CORS — only needed if the browser ever uploads directly to S3; the default flow uploads
   through the API, so CORS can stay empty.
6. Switch the app over:

```
STORAGE_DRIVER=s3
AWS_REGION=ap-south-1
AWS_S3_BUCKET=clouddesk-uploads-<account-id>
```

On ECS/EC2 use a **task/instance role** instead of `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` — the AWS SDK picks the role up automatically.

## 2. S3 + CloudFront — frontend

1. `cd client && npm run build` (set `VITE_API_BASE_URL` to your API origin, or keep `/api`
   and route it through CloudFront).
2. Upload `client/dist` to a second private bucket.
3. Create a CloudFront distribution with an **Origin Access Control** to that bucket.
4. Add a second origin for the API (ALB) with a `/api/*` behaviour, caching disabled and all
   headers/cookies forwarded.
5. Add a custom error response: `403` and `404` → `/index.html` with status `200`. React Router
   needs this SPA fallback.
6. Attach an ACM certificate (must be in `us-east-1`) for your domain.

Invalidate `/*` after each deploy.

## 3. RDS — PostgreSQL

1. PostgreSQL 16, start with `db.t4g.micro` (free-tier eligible) and scale later.
2. Deploy in **private subnets**; do not enable public accessibility.
3. Security group: allow `5432` **only** from the API's security group.
4. Enable automated backups (7–14 days), Multi-AZ for production, and storage autoscaling.
5. Store the connection string in Secrets Manager and inject it as `DATABASE_URL`.
6. Run migrations once from a bastion, a one-off ECS task, or on container boot:
   `npx prisma migrate deploy`. Do **not** run the development seed in production.

## 4. Compute — ECS Fargate (recommended) or EC2

**ECS Fargate**

1. Build and push the API image:
   ```bash
   aws ecr create-repository --repository-name clouddesk-api
   docker build -t clouddesk-api ./server
   docker tag clouddesk-api:latest <acct>.dkr.ecr.<region>.amazonaws.com/clouddesk-api:latest
   docker push <acct>.dkr.ecr.<region>.amazonaws.com/clouddesk-api:latest
   ```
2. Task definition: 0.5 vCPU / 1 GB to start, port 5000, `awslogs` driver, secrets pulled from
   Secrets Manager, and a task role granting S3 access.
3. Service behind an Application Load Balancer with a health check on `/health`.
4. Enable service autoscaling on CPU or request count.

**EC2 (simpler, cheaper for a demo)**

A single `t4g.small` running `docker compose` works fine: install Docker, clone the repo,
create `server/.env`, then `docker compose up -d`. Put nginx or an ALB in front for TLS.

## 5. IAM

Principle of least privilege:

- **Task/instance role** — only `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on
  `arn:aws:s3:::clouddesk-uploads-*/*`, plus `secretsmanager:GetSecretValue` for its own
  secrets and `logs:CreateLogStream` / `logs:PutLogEvents`.
- **Deploy role (CI)** — ECR push, ECS update-service, S3 sync and CloudFront invalidation.
  Use GitHub OIDC rather than long-lived access keys.
- No IAM user should ever hold the application's runtime credentials.

## 6. CloudWatch

- Pino writes structured JSON to stdout, so the `awslogs` driver gives you queryable logs for
  free. Set a retention policy (e.g. 30 days) — the default is "never expire" and costs money.
- Useful alarms: ALB 5xx rate, ECS CPU/memory, RDS free storage and CPU, and a log-metric
  filter on `level: 50` (Pino error).
- Container Insights gives per-task metrics if you want them.

## 7. Environment variables in AWS

| Variable | Source |
| --- | --- |
| `DATABASE_URL` | Secrets Manager (RDS credentials) |
| `JWT_SECRET` | Secrets Manager |
| `GEMINI_API_KEY` | Secrets Manager (optional — fallback works without it) |
| `STORAGE_DRIVER` | Task definition: `s3` |
| `AWS_REGION`, `AWS_S3_BUCKET` | Task definition |
| `CLIENT_ORIGIN` | Task definition: your CloudFront domain |
| `NODE_ENV` | `production` |
| `LOG_LEVEL` | `info` |

Never bake secrets into an image or a task definition's plain `environment` block.

## 8. Deployment steps in order

1. Create the VPC (or use the default), subnets and security groups.
2. Provision RDS; store the credentials in Secrets Manager.
3. Create both S3 buckets.
4. Build and push the API image to ECR.
5. Create the ECS cluster, task definition and service behind an ALB.
6. Run `prisma migrate deploy` once.
7. Build the frontend and sync it to the web bucket.
8. Create the CloudFront distribution with the SPA fallback and the `/api/*` behaviour.
9. Point DNS (Route 53) at CloudFront, attach the ACM certificate.
10. Add CloudWatch alarms and log retention.
11. Smoke-test `/health`, then log in and create a ticket.

## 9. Security checklist

- [ ] RDS in private subnets, never publicly accessible
- [ ] Upload bucket blocks all public access; presigned URLs only
- [ ] Secrets in Secrets Manager/SSM, never in the repo or the image
- [ ] Strong `JWT_SECRET`, rotated on a schedule
- [ ] HTTPS everywhere; HTTP redirected at CloudFront and the ALB
- [ ] Development seed users removed or given real passwords
- [ ] `CLIENT_ORIGIN` set to the real domain so CORS is not permissive
- [ ] Security-group rules scoped to other security groups, not `0.0.0.0/0`
- [ ] CloudTrail on; GuardDuty if the budget allows

## 10. Rough monthly cost (ap-south-1, demo scale)

| Service | Configuration | Approx. USD/month |
| --- | --- | --- |
| RDS PostgreSQL | db.t4g.micro, 20 GB, single-AZ | 12–18 |
| ECS Fargate | 0.5 vCPU / 1 GB, always on | 12–18 |
| ALB | 1 load balancer | ~18 |
| S3 | a few GB + requests | <1 |
| CloudFront | low traffic (1 TB free tier first year) | 0–2 |
| CloudWatch | 30-day retention, low volume | 1–3 |
| **Total** | | **~45–60** |

Cheaper alternatives: run everything on a single `t4g.small` EC2 instance with Docker Compose
(~10–15 USD/month), or use RDS free tier for the first 12 months. Cost drivers to watch are the
ALB, Multi-AZ RDS, NAT gateways (avoid them by using public subnets with strict security groups
for the API tier, or VPC endpoints) and unbounded CloudWatch retention.
