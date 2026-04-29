from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.constants import FastPanelStatus, ServerStatus

if TYPE_CHECKING:
    from app.models.server import Server


def parse_os_pretty_name(os_release_text: str) -> Optional[str]:
    for raw in os_release_text.splitlines():
        line = raw.strip()
        if not line.startswith("PRETTY_NAME="):
            continue
        value = line.split("=", 1)[1].strip().strip('"').strip("'")
        return value or None
    return None


def parse_mem_row(free_m_text: str) -> tuple[Optional[int], Optional[int]]:
    for raw in free_m_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        parts = line.split()
        if parts[0] != "Mem:" or len(parts) < 3:
            continue
        try:
            total = int(float(parts[1]))
            used = int(float(parts[2]))
            return total, used
        except ValueError:
            return None, None
    return None, None


def _safe_int(value: str) -> Optional[int]:
    try:
        return int(float(value.strip()))
    except Exception:
        return None


def _parse_root_disk(df_out: str) -> tuple[Optional[int], Optional[int]]:
    rows = [ln.strip() for ln in df_out.splitlines() if ln.strip()]
    if len(rows) < 2:
        return None, None
    vals = rows[-1].split()
    if len(vals) < 2:
        return None, None
    total = _safe_int(vals[0].replace("G", ""))
    used = _safe_int(vals[1].replace("G", ""))
    return total, used


def _parse_net_totals(proc_net_dev: str) -> tuple[int, int]:
    rx = 0
    tx = 0
    for ln in proc_net_dev.splitlines():
        if ":" not in ln:
            continue
        iface, rest = ln.split(":", 1)
        name = iface.strip()
        if name == "lo":
            continue
        cols = rest.split()
        if len(cols) < 9:
            continue
        rx += _safe_int(cols[0]) or 0
        tx += _safe_int(cols[8]) or 0
    return rx, tx


def _parse_uptime_seconds(text: str) -> Optional[int]:
    chunks = text.split()
    if not chunks:
        return None
    return _safe_int(chunks[0])


def _parse_cpu_usage_pct(top_out: str) -> Optional[int]:
    value = top_out.strip().replace(",", ".")
    parsed = _safe_int(value)
    if parsed is None:
        return None
    return max(0, min(100, parsed))


def collect_metrics(server: "Server", ssh_password: str, timeout: int = 15) -> dict:
    from app.services.fastpanel_client import get_fastpanel_path, run_remote
    from app.services.server_service import _open_ssh_client

    payload: dict[str, object] = {
        "uptime_seconds": None,
        "cpu_usage_pct": None,
        "cpu_count": None,
        "ram_used_mb": None,
        "ram_total_mb": None,
        "disk_used_gb": None,
        "disk_total_gb": None,
        "net_in_kbps": None,
        "net_out_kbps": None,
        "os_pretty": None,
        "kernel": None,
        "fastpanel_version": None,
        "fastpanel_port": server.fastpanel_port or 8888,
        "status": server.status,
    }

    client = _open_ssh_client(server, ssh_password, timeout=timeout)
    try:
        _, os_out = run_remote(client, "cat /etc/os-release")
        os_pretty = parse_os_pretty_name(os_out)
        if os_pretty:
            payload["os_pretty"] = os_pretty
            if not server.os:
                payload["os"] = os_pretty

        _, kernel_out = run_remote(client, "uname -r")
        payload["kernel"] = kernel_out.strip() or None

        _, cpu_count_out = run_remote(client, "nproc")
        payload["cpu_count"] = _safe_int(cpu_count_out)

        _, cpu_out = run_remote(client, "top -bn1 | awk -F'[, ]+' '/Cpu\\(s\\)/ {print 100-$8}'")
        payload["cpu_usage_pct"] = _parse_cpu_usage_pct(cpu_out)

        _, mem_out = run_remote(client, "free -m")
        ram_total, ram_used = parse_mem_row(mem_out)
        payload["ram_total_mb"] = ram_total
        payload["ram_used_mb"] = ram_used

        _, disk_out = run_remote(client, "df -BG --output=size,used /")
        disk_total, disk_used = _parse_root_disk(disk_out)
        payload["disk_total_gb"] = disk_total
        payload["disk_used_gb"] = disk_used

        _, net1 = run_remote(client, "cat /proc/net/dev")
        _, net2 = run_remote(client, "sleep 1; cat /proc/net/dev")
        rx1, tx1 = _parse_net_totals(net1)
        rx2, tx2 = _parse_net_totals(net2)
        payload["net_in_kbps"] = max(0, int((rx2 - rx1) * 8 / 1000))
        payload["net_out_kbps"] = max(0, int((tx2 - tx1) * 8 / 1000))

        _, uptime_out = run_remote(client, "cat /proc/uptime")
        payload["uptime_seconds"] = _parse_uptime_seconds(uptime_out)

        if server.fastpanel_status == FastPanelStatus.INSTALLED.value:
            fp_path = get_fastpanel_path(client)
            if fp_path:
                code, fp_version = run_remote(client, f"{fp_path} --version")
                if code == 0:
                    payload["fastpanel_version"] = fp_version.strip().splitlines()[0] if fp_version.strip() else None

        payload["last_check_ok"] = True
        payload["last_check_error"] = None
        if server.fastpanel_status == FastPanelStatus.INSTALLED.value:
            payload["status"] = ServerStatus.ACTIVE.value
        else:
            payload["status"] = ServerStatus.PROVISIONED.value
    finally:
        client.close()

    return payload


async def persist_metrics(session: AsyncSession, server_id: int, payload: dict) -> Optional["Server"]:
    from app.models.server import Server

    server = await session.get(Server, server_id)
    if not server:
        return None
    for key, value in payload.items():
        if hasattr(server, key):
            setattr(server, key, value)
    now = datetime.now(timezone.utc)
    server.last_check_at = now
    server.metrics_collected_at = now
    await session.commit()
    await session.refresh(server)
    return server
