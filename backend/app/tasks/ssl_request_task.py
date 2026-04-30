from app.core.celery_app import celery_app
from app.tasks.provision_task import provision_domain


@celery_app.task(name="app.tasks.domain.request_ssl")
def request_ssl(domain_id: int) -> dict:
    # Current provisioning flow is idempotent and skips existing site/FTP,
    # so it can be reused for explicit SSL request actions.
    return provision_domain(domain_id)
