from fastapi import APIRouter

from app.api.routes.cloudflare import router as cloudflare_router
from app.api.routes.domains import router as domains_router
from app.api.routes.notifications import router as notifications_router
from app.api.routes.registrars import router as registrars_router
from app.api.routes.servers import router as servers_router
from app.api.routes.settings import router as settings_router
from app.api.routes.ssl_emails import router as ssl_emails_router
from app.api.routes.tasks import router as tasks_router
from app.audit.routes import router as audit_router
from app.auth.routes import router as auth_router
from app.blobs.routes import router as blobs_router
from app.sync.routes import router as sync_router

api_router = APIRouter()
api_router.include_router(auth_router)
api_router.include_router(audit_router)
api_router.include_router(blobs_router)
api_router.include_router(sync_router)
api_router.include_router(servers_router)
api_router.include_router(cloudflare_router)
api_router.include_router(domains_router)
api_router.include_router(registrars_router)
api_router.include_router(tasks_router)
api_router.include_router(notifications_router)
api_router.include_router(settings_router)
api_router.include_router(ssl_emails_router)
