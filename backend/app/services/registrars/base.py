from abc import ABC, abstractmethod

from app.models.registrar_account import RegistrarAccount


class RegistrarError(Exception):
    pass


class BaseRegistrarService(ABC):
    provider: str = ""

    def __init__(self, account: RegistrarAccount) -> None:
        self.account = account

    @abstractmethod
    async def test_connection(self) -> tuple[bool, str]:
        ...

    @abstractmethod
    async def get_domains(self) -> list[dict]:
        ...

    @abstractmethod
    async def set_nameservers(self, domain: str, ns_list: list[str]) -> bool:
        ...

    @abstractmethod
    async def get_nameservers(self, domain: str) -> list[str]:
        ...
