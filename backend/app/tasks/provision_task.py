import asyncio

from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.domain import Domain
from app.models.server import Server, ServerSecret
from app.models.system_config import SystemConfig
from app.models.task_log import TaskLog
from app.services.encryption_service import decrypt, encrypt
from app.services.fastpanel_client import (
    cert_exists,
    create_ftp_account,
    create_site,
    get_fastpanel_path,
    issue_ssl_certificate,
    open_ssh,
    site_exists,
)
from app.services.ssl_email_service import mark_used, pick_email


async def _append_log(session, task_log: TaskLog, chunk: str, status_value: str | None = None) -> None:
    task_log.log_text = (task_log.log_text or "") + chunk
    if status_value:
        task_log.status = status_value
    await session.commit()


async def _create_task_log(domain_id: int) -> int:
    async with AsyncSessionLocal() as session:
        tl = TaskLog(
            entity_type="domain",
            entity_id=domain_id,
            task_type="provision_domain",
            status="pending",
            log_text="",
        )
        session.add(tl)
        await session.commit()
        await session.refresh(tl)
        return tl.id


async def _default_php_version(session) -> str:
    cfg = await session.get(SystemConfig, "Default PHP Version")
    if cfg and cfg.value.strip():
        return cfg.value.strip()
    return "7.4"


async def _main(domain_id: int, task_log_id: int | None = None) -> dict:
    if task_log_id is None:
        task_log_id = await _create_task_log(domain_id)
    async with AsyncSessionLocal() as session:
        task_log = await session.get(TaskLog, task_log_id)
        if task_log is None:
            return {"domain_id": domain_id, "task_log_id": task_log_id}

        domain = (
            await session.execute(select(Domain).where(Domain.id == domain_id))
        ).scalar_one_or_none()
        if domain is None:
            await _append_log(session, task_log, "Domain not found\n", "failed")
            return {"domain_id": domain_id, "task_log_id": task_log_id}
        if not domain.server_id:
            domain.status = "failed"
            await session.commit()
            await _append_log(session, task_log, "Domain has no assigned server\n", "failed")
            return {"domain_id": domain_id, "task_log_id": task_log_id}

        server = await session.get(Server, domain.server_id)
        secret = (
            await session.execute(
                select(ServerSecret).where(ServerSecret.server_id == domain.server_id)
            )
        ).scalar_one_or_none()
        if server is None or secret is None or not secret.ssh_password_encrypted:
            domain.status = "failed"
            await session.commit()
            await _append_log(
                session,
                task_log,
                "Server or SSH secret is missing\n",
                "failed",
            )
            return {"domain_id": domain_id, "task_log_id": task_log_id}

        ssh_password = decrypt(secret.ssh_password_encrypted)
        php_version = await _default_php_version(session)
        client = None
        site_ok = False
        try:
            await _append_log(
                session,
                task_log,
                f"Connecting to {server.ip_address}:{server.ssh_port}\n",
                "running",
            )
            client = await asyncio.to_thread(
                open_ssh,
                server.ip_address,
                server.ssh_port,
                server.ssh_user,
                ssh_password,
            )
            fp_path = await asyncio.to_thread(get_fastpanel_path, client, None)
            if not fp_path:
                domain.status = "failed"
                await session.commit()
                await _append_log(session, task_log, "FastPanel binary not found\n", "failed")
                return {"domain_id": domain_id, "task_log_id": task_log_id}

            if domain.site_user and await asyncio.to_thread(
                site_exists, client, domain.site_user, domain.domain_name
            ):
                site_ok = True
                await _append_log(session, task_log, "Site already exists, skipping\n")
            else:
                site_result = await asyncio.to_thread(
                    create_site, client, fp_path, domain.domain_name, php_version
                )
                if not site_result["success"]:
                    domain.status = "failed"
                    await session.commit()
                    await _append_log(
                        session,
                        task_log,
                        f"Site create failed: {site_result['error']}\n",
                        "failed",
                    )
                    return {"domain_id": domain_id, "task_log_id": task_log_id}
                domain.site_user = site_result["site_user"]
                domain.site_path = site_result["site_path"]
                domain.php_version = php_version
                domain.status = "provisioning"
                await session.commit()
                await _append_log(session, task_log, "Site created\n")
                site_ok = True

            if domain.ftp_user:
                await _append_log(session, task_log, "FTP already exists, skipping\n")
            else:
                ftp_result = await asyncio.to_thread(
                    create_ftp_account, client, fp_path, domain.domain_name
                )
                if not ftp_result["success"]:
                    await _append_log(
                        session,
                        task_log,
                        f"FTP create failed: {ftp_result['error']}\n",
                    )
                else:
                    domain.ftp_user = ftp_result["ftp_user"]
                    domain.ftp_password_encrypted = encrypt(ftp_result["ftp_password"])
                    await session.commit()
                    await _append_log(session, task_log, "FTP account created\n")

            ssl_active = (
                domain.ssl_status == "active"
                and await asyncio.to_thread(cert_exists, client, domain.domain_name)
            )
            if ssl_active:
                await _append_log(session, task_log, "SSL already active, skipping\n")
            else:
                ssl_email = await pick_email(session)
                if ssl_email is None:
                    domain.ssl_status = "error"
                    await session.commit()
                    await _append_log(
                        session,
                        task_log,
                        "SSL email pool exhausted\n",
                    )
                else:
                    ssl_result = await asyncio.to_thread(
                        issue_ssl_certificate,
                        client,
                        fp_path,
                        domain.domain_name,
                        ssl_email.email,
                    )
                    if ssl_result["success"]:
                        domain.ssl_status = "active"
                        domain.ssl_email_used = ssl_email.email
                        await session.commit()
                        await mark_used(session, ssl_email.id)
                        await _append_log(session, task_log, "SSL certificate issued\n")
                    else:
                        domain.ssl_status = "error"
                        await session.commit()
                        await _append_log(
                            session,
                            task_log,
                            f"SSL issue failed: {ssl_result['error']}\n",
                        )

            domain.status = "active" if site_ok else "failed"
            await session.commit()
            await _append_log(session, task_log, "Provisioning finished\n", "success")
        except Exception as exc:
            domain.status = "failed"
            await session.commit()
            await _append_log(
                session,
                task_log,
                f"Error: {type(exc).__name__}: {exc}\n",
                "failed",
            )
        finally:
            if client is not None:
                await asyncio.to_thread(client.close)
    return {"domain_id": domain_id, "task_log_id": task_log_id}


@celery_app.task(name="app.tasks.provision.provision_domain")
def provision_domain(domain_id: int, task_log_id: int | None = None) -> dict:
    return asyncio.run(_main(domain_id, task_log_id))
