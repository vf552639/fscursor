from enum import StrEnum


class ServerStatus(StrEnum):
    NEW = "new"
    ACTIVE = "active"
    FAILED = "failed"


class FastPanelStatus(StrEnum):
    NOT_INSTALLED = "not_installed"
    PENDING = "pending"
    UPDATING = "updating"
    INSTALLING = "installing"
    INSTALLED = "installed"
    FAILED = "failed"


class DomainStatus(StrEnum):
    NEW = "new"
    NS_PENDING = "ns_pending"
    NS_OK = "ns_ok"
    PROVISIONING = "provisioning"
    SITE_CREATED = "site_created"
    SSL_PENDING = "ssl_pending"
    ACTIVE = "active"
    FAILED = "failed"


class SslStatus(StrEnum):
    NONE = "none"
    PENDING = "pending"
    ACTIVE = "active"
    ERROR = "error"


class TaskLogStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCESS = "success"
    FAILED = "failed"


DOMAIN_REGEX = r"^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$"
EMAIL_REGEX = r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$"
IPV4_REGEX = r"^((25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(25[0-5]|2[0-4]\d|[01]?\d?\d)$"
