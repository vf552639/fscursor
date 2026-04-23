# KNOWN BUGS AND FOLLOW-UPS

## Open Issues

1. **Renewal notifications require runtime verification in live compose**
   - *Severity*: Medium
   - *Impact*: Feature implemented, but needs confirmation in running containers (`backend`, `worker`, `beat`) with real task execution traces.
   - *Next*: Run end-to-end checklist and capture expected outputs (`/notifications`, unread badge changes, task log entries).

2. **FastPanel and registrar flows still need deeper hardening**
   - *Severity*: Medium
   - *Impact*: Core flows work but need stronger retries, observability, and edge-case handling for provider/network failures.
   - *Next*: Add retry policies, better surfaced errors, and regression tests.

3. **Notifications UX can be expanded**
   - *Severity*: Medium
   - *Impact*: Page supports list/read/delete, but lacks richer actions (grouping, deep links, optional admin trigger UI, toasts consistency).
   - *Next*: Add reusable toaster integration and optional "check renewals now" UI action.

4. **Local frontend build still depends on host runtime outside Docker**
   - *Severity*: Low
   - *Impact*: `npm run build` can fail outside Docker on outdated host runtimes.
   - *Next*: Document required Node version and prefer containerized build checks.
