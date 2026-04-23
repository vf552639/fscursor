import asyncio
import re
from typing import Optional

import paramiko
from sqlalchemy import select

from app.core.celery_app import celery_app
from app.core.database import AsyncSessionLocal
from app.models.server import Server, ServerSecret
from app.models.task_log import TaskLog
from app.services.encryption_service import decrypt, encrypt

INSTALL_CMD = (
    "wget https://repo.fastpanel.direct/install_fastpanel.sh -O - | bash -"
)


async def _set_status(session, server: Server, status_value: str) -> None:
    server.fastpanel_status = status_value
    await session.commit()


async def _append_log(
    session, task_log: TaskLog, chunk: str, status_value: Optional[str] = None
) -> None:
    task_log.log_text = (task_log.log_text or "") + chunk
    if status_value:
        task_log.status = status_value
    await session.commit()


def _update_cmd(os_name: Optional[str]) -> str:
    if os_name and re.search(r"cent|rhel|rocky|alma|fedora", os_name, re.I):
        return "yum -y update"
    return "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y upgrade"


def _parse_credentials(output: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    url = None
    user = None
    password = None
    url_m = re.search(r"https?://[^\s]+:8888[^\s]*", output)
    if url_m:
        url = url_m.group(0).rstrip(".,")
    user_m = re.search(r"(?:Username|Login|User)\s*[:=]\s*(\S+)", output, re.I)
    if user_m:
        user = user_m.group(1)
    pass_m = re.search(r"Password\s*[:=]\s*(\S+)", output, re.I)
    if pass_m:
        password = pass_m.group(1)
    return url, user, password


def _run_remote(client: paramiko.SSHClient, cmd: str) -> tuple[int, str]:
    transport = client.get_transport()
    assert transport is not None
    chan = transport.open_session()
    chan.get_pty()
    chan.exec_command(cmd)
    buf = b""
    while True:
        if chan.recv_ready():
            buf += chan.recv(65536)
        if chan.exit_status_ready() and not chan.recv_ready():
            break
    buf += chan.recv(65536)
    code = chan.recv_exit_status()
    return code, buf.decode("utf-8", errors="ignore")


async def _install(server_id: int, task_log_id: int) -> None:
    async with AsyncSessionLocal() as session:
        server = (
            await session.execute(
                select(Server).where(Server.id == server_id)
            )
        ).scalar_one_or_none()
        if not server:
            return
        secret = (
            await session.execute(
                select(ServerSecret).where(ServerSecret.server_id == server_id)
            )
        ).scalar_one_or_none()
        task_log = await session.get(TaskLog, task_log_id)
        if task_log is None:
            return

        if not secret or not secret.ssh_password_encrypted:
            await _set_status(session, server, "failed")
            await _append_log(session, task_log, "SSH password is not set\n", "failed")
            return

        password = decrypt(secret.ssh_password_encrypted)

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        try:
            await _append_log(session, task_log, f"Connecting to {server.ip_address}:{server.ssh_port}\n", "running")
            client.connect(
                hostname=server.ip_address,
                port=server.ssh_port,
                username=server.ssh_user,
                password=password,
                timeout=20,
                allow_agent=False,
                look_for_keys=False,
            )

            await _set_status(session, server, "updating")
            await _append_log(session, task_log, "System update started\n")
            code, out = _run_remote(client, _update_cmd(server.os))
            await _append_log(session, task_log, out)
            if code != 0:
                await _set_status(session, server, "failed")
                await _append_log(session, task_log, f"Update failed (exit {code})\n", "failed")
                return

            await _set_status(session, server, "installing")
            await _append_log(session, task_log, "FastPanel installation started\n")
            code, out = _run_remote(client, INSTALL_CMD)
            await _append_log(session, task_log, out)
            if code != 0:
                await _set_status(session, server, "failed")
                await _append_log(session, task_log, f"Installer failed (exit {code})\n", "failed")
                return

            url, user, fp_password = _parse_credentials(out)
            server.fastpanel_url = url
            server.fastpanel_user = user
            if fp_password:
                server.fastpanel_password_encrypted = encrypt(fp_password)
            server.status = "active"
            await _set_status(session, server, "installed")
            await _append_log(session, task_log, "FastPanel installed\n", "success")
        except Exception as e:
            await _set_status(session, server, "failed")
            await _append_log(session, task_log, f"Error: {type(e).__name__}: {e}\n", "failed")
        finally:
            client.close()


async def _create_task_log(server_id: int) -> int:
    async with AsyncSessionLocal() as session:
        tl = TaskLog(
            entity_type="server",
            entity_id=server_id,
            task_type="install_fastpanel",
            status="pending",
            log_text="",
        )
        session.add(tl)
        await session.commit()
        await session.refresh(tl)
        return tl.id


@celery_app.task(name="app.tasks.fastpanel.install_fastpanel")
def install_fastpanel(server_id: int) -> dict:
    task_log_id = asyncio.run(_create_task_log(server_id))
    asyncio.run(_install(server_id, task_log_id))
    return {"server_id": server_id, "task_log_id": task_log_id}
