import secrets
import shlex
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
    client: paramiko.SSHClient, cmd: str, timeout: int | None = None
) -> tuple[int, str]:
    transport = client.get_transport()
    if transport is None:
        return 1, "SSH transport is not available"
    chan = transport.open_session()
    if timeout is not None:
        chan.settimeout(timeout)
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
