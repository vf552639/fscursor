from typing import Optional

import paramiko
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.server import Server, ServerSecret
from app.schemas.server import ServerCreate, ServerUpdate
from app.services.encryption_service import decrypt, encrypt


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
    if data.fastpanel_status == "installed":
        server.status = "active"

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
    return result.scalar_one()


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
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=server.ip_address,
            port=server.ssh_port,
            username=server.ssh_user,
            password=password,
            timeout=10,
            allow_agent=False,
            look_for_keys=False,
        )
        stdin, stdout, stderr = client.exec_command("uname -a", timeout=10)
        out = stdout.read().decode("utf-8", errors="ignore").strip()
        return True, out or "connected"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
    finally:
        client.close()
