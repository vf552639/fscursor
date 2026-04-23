# PROJECT OVERVIEW

**Project Name:** SDMP (Server & Domain Management Panel)

## Purpose
SDMP is an internal panel for centralized management of servers and domains with background automation (Celery), DNS/registrar integrations, and operational visibility in one UI.

## Implemented Scope (Current)
1. **Servers**
   - CRUD for servers
   - FastPanel connection/install lifecycle
   - SSH-related setup flow and status tracking
2. **Domains**
   - CRUD, bulk import (text + structured CSV-like)
   - Bulk actions (assign server, assign Cloudflare, set NS, delete)
   - New `purchase_date` support for renewal lifecycle
3. **Notifications**
   - Dedicated notifications entity and API
   - Domain renewal reminder generation at `purchase_date + 9 months`
   - Deduplication by `(domain_id, purchase_date)` via `dedup_key`
   - Read/unread and delete flows in UI
4. **Cloudflare / Registrars**
   - Account and zone-level integration primitives
   - DNS and nameserver-related operations
5. **Task Processing**
   - Celery worker for async jobs
   - Celery Beat for periodic jobs (daily renewal check)
   - Task audit logs in database

## Key Entities
- `servers`, `server_secrets`, `task_logs`
- `domains` (including `purchase_date`)
- `notifications`
- `cloudflare_accounts`
- `registrar_accounts`
- `activity_logs`
