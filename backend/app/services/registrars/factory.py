from app.models.registrar_account import RegistrarAccount
from app.services.registrars.base import BaseRegistrarService, RegistrarError
from app.services.registrars.hostiq import HostiqService
from app.services.registrars.namecheap import NamecheapService

_REGISTRY: dict[str, type[BaseRegistrarService]] = {
    "hostiq": HostiqService,
    "namecheap": NamecheapService,
}


def get_service(account: RegistrarAccount) -> BaseRegistrarService:
    provider = (account.provider or "").lower()
    cls = _REGISTRY.get(provider)
    if cls is None:
        raise RegistrarError(f"Unknown registrar provider: {account.provider}")
    return cls(account)
