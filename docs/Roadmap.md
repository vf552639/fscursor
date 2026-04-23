# ROADMAP

## Phase 1-5 (Done)
- [x] Core backend/frontend modules and integrations
- [x] Domain bulk operations
- [x] Celery worker-based async task processing

## Phase 6 - Reliability & Feedback (Current)
- [x] Add `purchase_date` to domains
- [x] Add notifications subsystem (`notifications` model/API/UI)
- [x] Implement renewal reminder rule (`purchase_date + 9 months`)
- [x] Add deduplication per `(domain_id, purchase_date)`
- [x] Add Celery Beat service and daily scheduled renewal checks
- [x] Add unread badge in topbar and notifications page actions
- [ ] Complete full E2E runtime verification and attach runbook notes
- [ ] Add focused tests (notification service + renewal task)

## Phase 7 - Production Readiness
- [ ] Authentication and authorization hardening for internet-facing deployment
- [ ] CI/CD pipeline (`tsc`, lint, backend checks/tests)
- [ ] Production frontend build and optimized nginx serving
- [ ] Operational monitoring and alerting baseline
