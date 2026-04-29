import json
import re
import secrets
import shlex
import socket
import string
import time

import paramiko

FASTPANEL_FALLBACK_PATH = "/usr/local/fastpanel2/fastpanel"


def open_ssh(
    host: str, port: int, user: str, password: str, timeout: int = 20
) -> paramiko.SSHClient:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=host,
        port=port,
        username=user,
        password=password,
        timeout=timeout,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run_remote(
    client: paramiko.SSHClient, cmd: str, timeout: int | None = None, pty: bool = True
) -> tuple[int, str]:
    transport = client.get_transport()
    if transport is None:
        return 1, "SSH transport is not available"
    chan = transport.open_session()
    if timeout is not None:
        chan.settimeout(timeout)
    if pty:
        chan.get_pty()
    chan.exec_command(cmd)
    buf = b""
    while True:
        if chan.recv_ready():
            buf += chan.recv(65536)
        if chan.exit_status_ready() and not chan.recv_ready():
            break
    if chan.recv_ready():
        buf += chan.recv(65536)
    code = chan.recv_exit_status()
    return code, buf.decode("utf-8", errors="ignore")


def get_fastpanel_path(client: paramiko.SSHClient, override: str | None = None) -> str | None:
    if override:
        return override
    code, out = run_remote(client, "which fastpanel")
    if code == 0 and out.strip():
        return out.strip().splitlines()[0].strip()
    code, out = run_remote(client, f"test -x {shlex.quote(FASTPANEL_FALLBACK_PATH)}")
    if code == 0:
        return FASTPANEL_FALLBACK_PATH
    return None


def make_site_user(domain: str) -> str:
    slug = domain.split(".", 1)[0].replace("-", "_")
    return f"{slug[:12]}_usr"


def make_ftp_login(domain: str) -> str:
    slug = domain.split(".", 1)[0].replace("-", "_")
    return f"ftp_{slug}"


def generate_password(length: int = 14) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(length))


def site_exists(client: paramiko.SSHClient, site_user: str, domain: str) -> bool:
    path = f"/var/www/{site_user}/data/www/{domain}"
    code, _ = run_remote(client, f"test -d {shlex.quote(path)}")
    return code == 0


def cert_exists(client: paramiko.SSHClient, domain: str) -> bool:
    path = f"/etc/letsencrypt/live/{domain}/fullchain.pem"
    code, _ = run_remote(client, f"test -f {shlex.quote(path)}")
    return code == 0


def create_site(
    client: paramiko.SSHClient, fp_path: str, domain: str, php_version: str
) -> dict:
    site_user = make_site_user(domain)
    cmd = (
        f"{shlex.quote(fp_path)} sites create "
        f"--server-name={shlex.quote(domain)} "
        f"--owner={shlex.quote(site_user)} "
        "--create-user "
        f"--php-version={shlex.quote(php_version)}"
    )
    code, out = run_remote(client, cmd)
    if code != 0:
        return {"success": False, "error": out or f"Site create failed: exit {code}"}
    if not site_exists(client, site_user, domain):
        return {"success": False, "error": "Site directory check failed"}
    return {
        "success": True,
        "error": None,
        "site_user": site_user,
        "site_path": f"/var/www/{site_user}/data/www/{domain}",
        "output": out,
    }


def create_ftp_account(client: paramiko.SSHClient, fp_path: str, domain: str) -> dict:
    ftp_user = make_ftp_login(domain)
    password = generate_password()
    cmd = (
        f"{shlex.quote(fp_path)} ftp_account create "
        f"--login={shlex.quote(ftp_user)} "
        f"--password={shlex.quote(password)} "
        f"--site={shlex.quote(domain)}"
    )
    code, out = run_remote(client, cmd)
    if code != 0:
        return {"success": False, "error": out or f"FTP create failed: exit {code}"}
    return {
        "success": True,
        "error": None,
        "ftp_user": ftp_user,
        "ftp_password": password,
        "output": out,
    }


def issue_ssl_certificate(
    client: paramiko.SSHClient, fp_path: str, domain: str, email: str
) -> dict:
    cmd = (
        f"{shlex.quote(fp_path)} certificates create-le "
        f"--server-name={shlex.quote(domain)} "
        f"--email={shlex.quote(email)}"
    )
    code, out = run_remote(client, cmd, timeout=300)
    if code != 0:
        return {"success": False, "error": out or f"SSL issue failed: exit {code}"}
    time.sleep(5)
    if not cert_exists(client, domain):
        return {"success": False, "error": "SSL certificate file check failed"}
    return {"success": True, "error": None, "output": out}


def detect_firewall(client: paramiko.SSHClient) -> str | None:
    for fw in ("ufw", "firewall-cmd"):
        code, _ = run_remote(client, f"command -v {shlex.quote(fw)}")
        if code == 0:
            return "ufw" if fw == "ufw" else "firewalld"
    return None


def ensure_ports_open(client: paramiko.SSHClient, ports: tuple[int, ...] = (80, 443)) -> dict:
    firewall = detect_firewall(client)
    if firewall is None:
        return {"success": True, "firewall": None, "output": "no firewall detected"}
    if firewall == "ufw":
        outputs: list[str] = []
        for port in ports:
            code, out = run_remote(client, f"ufw allow {int(port)}/tcp")
            outputs.append(out if out else f"ufw allow {port}/tcp -> {code}")
            if code != 0:
                return {"success": False, "firewall": firewall, "error": "".join(outputs)}
        return {"success": True, "firewall": firewall, "output": "\n".join(outputs)}
    outputs = []
    for port in ports:
        code, out = run_remote(
            client,
            f"firewall-cmd --permanent --add-port={int(port)}/tcp",
        )
        outputs.append(out if out else f"firewalld add-port {port}/tcp -> {code}")
        if code != 0 and "ALREADY_ENABLED" not in out:
            return {"success": False, "firewall": firewall, "error": "".join(outputs)}
    run_remote(client, "firewall-cmd --reload")
    return {"success": True, "firewall": firewall, "output": "\n".join(outputs)}


def dns_resolves_to(
    domain: str, expected_ip: str, attempts: int = 10, delay: int = 15
) -> bool:
    expected = expected_ip.strip()
    for idx in range(attempts):
        try:
            infos = socket.getaddrinfo(domain, None)
            ips = {info[4][0] for info in infos}
            if expected in ips:
                return True
        except Exception:
            pass
        if idx < attempts - 1:
            time.sleep(delay)
    return False


def http_check(domain: str, port: int = 80, timeout: int = 5) -> bool:
    try:
        with socket.create_connection((domain, port), timeout=timeout):
            return True
    except Exception:
        return False


def _normalize_site_row(raw: dict) -> dict | None:
    domain = (
        raw.get("domain_name")
        or raw.get("domain")
        or raw.get("server_name")
        or raw.get("name")
        or raw.get("site")
    )
    if not domain:
        return None
    site_user = raw.get("site_user") or raw.get("owner") or raw.get("user")
    site_path = raw.get("site_path") or raw.get("path") or raw.get("www_path")
    php_version = _coerce_php_version(raw.get("php_version") or raw.get("php"))
    return {
        "domain_name": str(domain).strip(),
        "site_user": str(site_user).strip() if site_user else None,
        "site_path": str(site_path).strip() if site_path else None,
        "php_version": str(php_version).strip() if php_version else None,
    }


def _coerce_php_version(raw: str | None) -> str | None:
    if not raw:
        return None
    match = re.search(r"\d+(?:\.\d+){0,2}", str(raw))
    return match.group(0) if match else None


def _parse_sites_from_text_table(output: str) -> list[dict]:
    sites: list[dict] = []
    for ln in output.splitlines():
        line = ln.strip()
        if not line:
            continue
        if re.search(r"\b(domain|site|owner|php)\b", line, re.I):
            continue
        if set(line) <= {"-", "+", "|", " "}:
            continue
        chunks = [part.strip() for part in re.split(r"\s{2,}|\t+|\|", line) if part.strip()]
        if not chunks:
            continue
        domain = chunks[0]
        if "." not in domain:
            continue
        site_user = chunks[1] if len(chunks) > 1 else None
        site_path = chunks[2] if len(chunks) > 2 else None
        php_version = _coerce_php_version(chunks[3] if len(chunks) > 3 else None)
        sites.append(
            {
                "domain_name": domain,
                "site_user": site_user,
                "site_path": site_path,
                "php_version": php_version,
            }
        )
    return sites


def _parse_sites_from_paths(output: str) -> list[dict]:
    rows: list[dict] = []
    for ln in output.splitlines():
        path = ln.strip()
        if not path or "/data/www/" not in path:
            continue
        # Expected path: /var/www/{site_user}/data/www/{domain}
        m = re.match(r"^/var/www/([^/]+)/data/www/([^/]+)$", path)
        if not m:
            continue
        rows.append(
            {
                "domain_name": m.group(2),
                "site_user": m.group(1),
                "site_path": path,
                "php_version": None,
            }
        )
    return rows


def list_sites(client: paramiko.SSHClient, fp_path: str | None) -> list[dict]:
    if fp_path:
        code, out = run_remote(
            client,
            f"{shlex.quote(fp_path)} sites list --json",
            timeout=15,
            pty=False,
        )
        if code == 0 and out.strip():
            try:
                raw = json.loads(out)
                if isinstance(raw, dict):
                    raw = raw.get("result") or raw.get("sites") or []
                if isinstance(raw, list):
                    rows: list[dict] = []
                    for item in raw:
                        if not isinstance(item, dict):
                            continue
                        normalized = _normalize_site_row(item)
                        if normalized:
                            rows.append(normalized)
                    if rows:
                        return rows
            except Exception:
                pass

        code, out = run_remote(
            client,
            f"{shlex.quote(fp_path)} sites list",
            timeout=15,
            pty=False,
        )
        if code == 0 and out.strip():
            rows = _parse_sites_from_text_table(out)
            if rows:
                return rows

    # Filesystem fallback (works even when fastpanel binary is not resolvable).
    code, out = run_remote(
        client,
        "python3 -c \"import glob; [print(p) for p in glob.glob('/var/www/*/data/www/*')]\"",
        timeout=15,
        pty=False,
    )
    if code == 0 and out.strip():
        return _parse_sites_from_paths(out)
    return []
