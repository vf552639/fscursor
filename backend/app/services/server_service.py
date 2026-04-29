from datetime import datetime, timezone
import re
import socket
from typing import Optional

import paramiko
from sqlalchemy import func, select
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.constants import FastPanelStatus, ServerStatus
from app.core.validators import is_valid_domain, normalize_domain
from app.models.domain import Domain
from app.models.server import Server, ServerSecret
from app.schemas.server import ServerCreate, ServerUpdate
from app.services import domain_service
from app.services.encryption_service import decrypt, encrypt
from app.services.fastpanel_client import get_fastpanel_path, list_sites


def _open_ssh_client(server: Server, password: str, timeout: int = 10) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=server.ip_address,
        port=server.ssh_port,
        username=server.ssh_user,
        password=password,
        timeout=timeout,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def _normalize_php_version(raw: str | None) -> str | None:
    if not raw:
        return None
    match = re.search(r"\d+(?:\.\d+){0,2}", str(raw))
    return match.group(0) if match else None


async def get_all(db: AsyncSession) -> tuple[list[Server], int]:
    result = await db.execute(select(Server).options(selectinload(Server.secret)).order_by(Server.id.desc()))
    items = list(result.scalars().all())
    total = (await db.execute(select(func.count(Server.id)))).scalar_one()
    return items, total


async def get_by_id(db: AsyncSession, server_id: int) -> Optional[Server]:
    result = await db.execute(
        select(Server).options(selectinload(Server.secret)).where(Server.id == server_id)
    )
    return result.scalar_one_or_none()


async def create(db: AsyncSession, data: ServerCreate) -> Server:
    payload = data.model_dump(exclude={"ssh_password", "fastpanel_password"})
    server = Server(**payload)
    
    # Auto-activate if connecting to an already installed FastPanel
    if data.fastpanel_status == FastPanelStatus.INSTALLED.value:
        server.status = ServerStatus.ACTIVE.value

    if data.fastpanel_password:
        server.fastpanel_password_encrypted = encrypt(data.fastpanel_password)
    db.add(server)
    await db.flush()

    if data.ssh_password:
        secret = ServerSecret(
            server_id=server.id,
            ssh_password_encrypted=encrypt(data.ssh_password),
        )
        db.add(secret)

    await db.commit()
    result = await db.execute(
        select(Server).options(selectinload(Server.secret)).where(Server.id == server.id)
    )
    created = result.scalar_one()

    if data.ssh_password:
        from app.tasks.server_health_task import check_server_metrics
        from app.tasks.server_health_task import sync_fastpanel_domains

        check_server_metrics.delay(created.id)
        if data.fastpanel_status == FastPanelStatus.INSTALLED.value:
            sync_fastpanel_domains.delay(created.id)

    return created


async def update(db: AsyncSession, server_id: int, data: ServerUpdate) -> Optional[Server]:
    server = await get_by_id(db, server_id)
    if not server:
        return None

    patch = data.model_dump(exclude_unset=True, exclude={"ssh_password", "fastpanel_password"})
    for k, v in patch.items():
        setattr(server, k, v)
        
    if data.fastpanel_password is not None:
        server.fastpanel_password_encrypted = encrypt(data.fastpanel_password)

    if data.ssh_password is not None:
        encrypted = encrypt(data.ssh_password)
        if server.secret:
            server.secret.ssh_password_encrypted = encrypted
        else:
            db.add(ServerSecret(server_id=server.id, ssh_password_encrypted=encrypted))

    await db.commit()
    result = await db.execute(
        select(Server).options(selectinload(Server.secret)).where(Server.id == server.id)
    )
    return result.scalar_one()


async def delete(db: AsyncSession, server_id: int) -> bool:
    server = await get_by_id(db, server_id)
    if not server:
        return False
    await db.delete(server)
    await db.commit()
    return True


async def test_ssh_connection(db: AsyncSession, server_id: int) -> tuple[bool, str]:
    server = await get_by_id(db, server_id)
    if not server:
        return False, "Server not found"
    if not server.secret or not server.secret.ssh_password_encrypted:
        return False, "SSH password is not set"

    password = decrypt(server.secret.ssh_password_encrypted)
    client: Optional[paramiko.SSHClient] = None
    try:
        client = _open_ssh_client(server, password, timeout=10)
        stdin, stdout, stderr = client.exec_command("uname -a", timeout=10)
        out = stdout.read().decode("utf-8", errors="ignore").strip()
        return True, out or "connected"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    finally:
        if client:
            client.close()


async def fetch_and_persist_uptime(db: AsyncSession, server_id: int) -> Optional[Server]:
    # Backward-compatible wrapper kept for older callers.
    return await fetch_and_persist_metrics(db, server_id)


async def fetch_and_persist_metrics(db: AsyncSession, server_id: int) -> Optional[Server]:
    server = await get_by_id(db, server_id)
    if not server:
        return None
    if not server.has_ssh or not server.secret or not server.secret.ssh_password_encrypted:
        return server

    password = decrypt(server.secret.ssh_password_encrypted)
    try:
        from app.services.server_metrics_service import collect_metrics

        payload = collect_metrics(server, password, timeout=10)
        for key, value in payload.items():
            if hasattr(server, key):
                setattr(server, key, value)
    except Exception as e:
        server.last_check_ok = False
        server.last_check_error = f"{type(e).__name__}: {e}"
        server.status = ServerStatus.ERROR.value

    server.last_check_at = datetime.now(timezone.utc)
    if server.last_check_ok:
        server.metrics_collected_at = server.last_check_at
    await db.commit()
    await db.refresh(server)
    return server


async def fetch_and_persist_domains(db: AsyncSession, server_id: int) -> dict:
    server = await get_by_id(db, server_id)
    if not server:
        return {"created": 0, "linked": 0, "total": 0, "error": "Server not found"}
    if not server.has_ssh or not server.secret or not server.secret.ssh_password_encrypted:
        return {"created": 0, "linked": 0, "total": 0, "error": "SSH password is not set"}

    password = decrypt(server.secret.ssh_password_encrypted)
    client: Optional[paramiko.SSHClient] = None
    created = 0
    linked = 0
    total = 0
    error: Optional[str] = None
    try:
        client = _open_ssh_client(server, password, timeout=10)
        fp_path = get_fastpanel_path(client)
        sites = list_sites(client, fp_path)
        total = len(sites)
        for site in sites:
            raw_name = str(site.get("domain_name") or "").strip()
            if not raw_name:
                continue
            name = normalize_domain(raw_name)
            if not is_valid_domain(name):
                continue
            existing = await domain_service.get_by_name(db, name)
            if existing:
                if existing.server_id is not None and existing.server_id != server.id:
                    other = await get_by_id(db, existing.server_id)
                    other_label = other.name if other else f"id={existing.server_id}"
                    await db.rollback()
                    if client:
                        client.close()
                        client = None
                    return {
                        "created": 0,
                        "linked": 0,
                        "total": total,
                        "error": (
                            f"Domain '{name}' is already linked to server '{other_label}' "
                            f"(id={existing.server_id}). Sync stopped."
                        ),
                    }
                existing.server_id = server.id
                existing.site_user = site.get("site_user")
                existing.site_path = site.get("site_path")
                normalized_php = _normalize_php_version(site.get("php_version"))
                if normalized_php:
                    existing.php_version = normalized_php
                linked += 1
                continue
            normalized_php = _normalize_php_version(site.get("php_version"))
            db.add(
                Domain(
                    domain_name=name,
                    server_id=server.id,
                    site_user=site.get("site_user"),
                    site_path=site.get("site_path"),
                    php_version=normalized_php,
                    status="active",
                )
            )
            created += 1
        server.last_check_ok = True
        server.last_check_error = None
    except (paramiko.SSHException, socket.timeout, TimeoutError) as exc:
        await db.rollback()
        server.last_check_ok = False
        server.last_check_error = f"{type(exc).__name__}: {exc}"
        server.status = ServerStatus.ERROR.value
        error = f"SSH timeout: {exc}"
    except (IntegrityError, DataError) as exc:
        await db.rollback()
        server.last_check_ok = False
        server.last_check_error = f"{type(exc).__name__}: {exc}"
        server.status = ServerStatus.ERROR.value
        orig = getattr(exc, "orig", exc)
        error = f"DB error: {orig}"
    except Exception as exc:
        await db.rollback()
        server.last_check_ok = False
        server.last_check_error = f"{type(exc).__name__}: {exc}"
        server.status = ServerStatus.ERROR.value
        error = str(exc)
    finally:
        if client:
            client.close()

    server.last_check_at = datetime.now(timezone.utc)
    try:
        await db.commit()
        await db.refresh(server)
    except (IntegrityError, DataError) as exc:
        await db.rollback()
        server.last_check_ok = False
        server.last_check_error = f"{type(exc).__name__}: {exc}"
        server.status = ServerStatus.ERROR.value
        orig = getattr(exc, "orig", exc)
        error = f"DB error: {orig}"
    except Exception as exc:
        await db.rollback()
        server.last_check_ok = False
        server.last_check_error = f"{type(exc).__name__}: {exc}"
        server.status = ServerStatus.ERROR.value
        error = f"{type(exc).__name__}: {exc}"
    return {"created": created, "linked": linked, "total": total, "error": error}
