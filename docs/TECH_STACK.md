# TECH STACK

## Backend
- Python 3.12
- FastAPI + Uvicorn
- SQLAlchemy Async + asyncpg (Supabase **transaction pooler** when using `*.pooler.supabase.com:6543`; `NullPool` + tuned `connect_args` — see `docs/SUPABASE_DOCKER.md`)
- Alembic (migration-driven schema updates)
- Celery 5 + Redis (worker + beat)
- Paramiko (SSH automation)
- `python-dateutil` (renewal threshold calculation)
- `cryptography` (encrypted secrets at rest)

## Frontend
- React 18 + TypeScript
- Vite
- TanStack Query (`@tanstack/react-query`)
- Axios-based API client/hooks

## Infrastructure
- Docker Compose
- PostgreSQL 16
- Redis 7
- Nginx reverse proxy

## External Integrations
- Cloudflare API
- Registrar APIs (Hostiq, Namecheap)
- FastPanel APIs / SSH-driven setup flows
