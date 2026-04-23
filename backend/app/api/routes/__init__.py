from fastapi import APIRouter

from app.api.routes.cloudflare import router as cloudflare_router
from app.api.routes.domains import router as domains_router
from app.api.routes.notifications import router as notifications_router
from app.api.routes.registrars import router as registrars_router
from app.api.routes.servers import router as servers_router
from app.api.routes.tasks import router as tasks_router

api_router = APIRouter()
api_router.include_router(servers_router)
api_router.include_router(cloudflare_router)
api_router.include_router(domains_router)
api_router.include_router(registrars_router)
api_router.include_router(tasks_router)
api_router.include_router(notifications_router)
