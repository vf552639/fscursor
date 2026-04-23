# ARCHITECTURE

## Docker Services
Current compose stack:

| Service | Host Port | Purpose |
|---|---:|---|
| `db` | `5532` | PostgreSQL 16 |
| `redis` | `6479` | Celery broker/backend |
| `backend` | `8100` | FastAPI API |
| `worker` | - | Celery worker (async tasks) |
| `beat` | - | Celery Beat (periodic scheduler) |
| `frontend` | `3100` | React + Vite |
| `nginx` | `8080` | Reverse proxy |

## Backend Architecture
- **App entry:** `backend/app/main.py`
- **Routers:** `servers`, `domains`, `cloudflare`, `registrars`, `tasks`, `notifications`
- **DB layer:** SQLAlchemy async sessions + Alembic migrations
- **Background tasks:** Celery + Redis
  - On-demand tasks (e.g., NS/FastPanel-related)
  - Scheduled tasks (renewal checks via Beat)
- **Renewal flow:**
  1. Periodic task selects domains with `purchase_date <= today - 9 months`.
  2. For each domain, creates notification using `ON CONFLICT DO NOTHING` by `dedup_key`.
  3. Writes audit entry to `task_logs`.

## Frontend Architecture
- React + TypeScript + TanStack Query
- API hooks layer in `frontend/src/api/*`
- Page modules in `frontend/src/pages/*`
- Notifications UX:
  - Dedicated `Notifications` page
  - Read/unread actions
  - Unread badge on topbar bell with polling

## Security Notes
- Sensitive values are encrypted at rest (based on configured encryption key).
- This deployment profile is internal/development-oriented; public exposure still requires full auth hardening and production controls.
