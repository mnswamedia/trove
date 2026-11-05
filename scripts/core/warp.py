"""
Cloudflare WARP WireGuard Tunnel Manager and Proxy Utilities.
Runs wireproxy as a lightweight background daemon to provide a local SOCKS5 proxy
bound to Cloudflare's global edge network, with ephemeral on-the-fly wgcf profile generation.
"""

import os
import re
import time
import socket
import shutil
import random
import tarfile
import tempfile
import subprocess
import urllib.request
import concurrent.futures
from pathlib import Path
try:
    from core.logger import log_event
except (ImportError, ModuleNotFoundError):
    try:
        from .logger import log_event
    except (ImportError, ModuleNotFoundError):
        from scripts.core.logger import log_event

CLOUDFLARE_WARP_IP = "162.159.192.1"
DEFAULT_WARP_PORT = int(os.getenv("WARP_PORT", "40000"))


class WarpTunnel:
    """
    Context manager to manage the Cloudflare WARP SOCKS5 tunnel lifecycle.
    Automatically registers a fresh WireGuard profile via wgcf or uses WARP_WG_CONF.
    """

    def __init__(self, port: int = DEFAULT_WARP_PORT):
        self.port = port
        self.temp_dir = tempfile.mkdtemp(prefix="trove_warp_")
        self.proc = None
        self.proxy_url = None
        self.log_file = None

    def __enter__(self):
        self.start()
        return self.proxy_url

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()

    def _ensure_wireproxy(self) -> str:
        """Find wireproxy in PATH or download static binary to temp directory."""
        which_path = shutil.which("wireproxy")
        if which_path:
            return which_path

        local_path = os.path.join(self.temp_dir, "wireproxy")
        if not os.path.exists(local_path):
            log_event("info", "warp:tunnel", message="Downloading wireproxy static binary...")
            url = "https://github.com/pufferffish/wireproxy/releases/latest/download/wireproxy_linux_amd64.tar.gz"
            tar_path = os.path.join(self.temp_dir, "wireproxy.tar.gz")
            urllib.request.urlretrieve(url, tar_path)
            with tarfile.open(tar_path, "r:gz") as tar:
                tar.extract("wireproxy", path=self.temp_dir)
            os.chmod(local_path, 0o755)
        return local_path

    def _ensure_wgcf(self) -> str:
        """Find wgcf in PATH or download static binary to temp directory."""
        which_path = shutil.which("wgcf")
        if which_path:
            return which_path

        local_path = os.path.join(self.temp_dir, "wgcf")
        if not os.path.exists(local_path):
            log_event("info", "warp:tunnel", message="Downloading wgcf static binary...")
            url = "https://github.com/ViRb3/wgcf/releases/download/v2.3.1/wgcf_2.3.1_linux_amd64"
            urllib.request.urlretrieve(url, local_path)
            os.chmod(local_path, 0o755)
        return local_path

    def _generate_wg_conf(self, work_dir: str = None) -> str:
        """Generate a fresh WireGuard profile via wgcf, mapping domain to IPv4 Anycast IP."""
        target_dir = work_dir or self.temp_dir
        wgcf_bin = self._ensure_wgcf()
        log_event("info", "warp:tunnel", message=f"Auto-generating fresh Cloudflare WARP account via wgcf...")

        subprocess.run(
            [wgcf_bin, "register", "--accept-tos"],
            cwd=target_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30
        )
        subprocess.run(
            [wgcf_bin, "generate"],
            cwd=target_dir,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30
        )

        profile_path = os.path.join(target_dir, "wgcf-profile.conf")
        target_conf = os.path.join(target_dir, "wg.conf")

        if os.path.exists(profile_path):
            with open(profile_path, "r", encoding="utf-8") as f:
                content = f.read()
            # Replace engage domain with direct Anycast IPv4 to prevent DNS hangs
            content = content.replace("engage.cloudflareclient.com", CLOUDFLARE_WARP_IP)
            with open(target_conf, "w", encoding="utf-8") as f:
                f.write(content)
            os.chmod(target_conf, 0o600)
            return target_conf

        return ""

    def _start_and_verify(self, wg_conf_path: str) -> bool:
        """Spawn wireproxy daemon and verify connectivity against YouTube."""
        wp_bin = self._ensure_wireproxy()
        wp_conf_path = os.path.join(self.temp_dir, "wireproxy.conf")
        with open(wp_conf_path, "w", encoding="utf-8") as f:
            f.write(f"WGConfig = {wg_conf_path}\n\n[Socks5]\nBindAddress = 127.0.0.1:{self.port}\n")

        log_path = os.path.join(self.temp_dir, "wireproxy.log")
        self.log_file = open(log_path, "w", encoding="utf-8")

        self.proc = subprocess.Popen(
            [wp_bin, "-s", "-c", wp_conf_path],
            stdout=self.log_file,
            stderr=subprocess.STDOUT
        )

        # Wait up to 5s for the local SOCKS5 port to open
        port_ready = False
        for _ in range(50):
            try:
                with socket.create_connection(("127.0.0.1", self.port), timeout=0.1):
                    port_ready = True
                    break
            except (OSError, ConnectionRefusedError):
                time.sleep(0.1)

        if not port_ready:
            self._terminate_proc()
            return False

        # Test HTTPS connectivity to YouTube ping endpoint through SOCKS5
        test_url = f"socks5h://127.0.0.1:{self.port}"
        try:
            res = subprocess.run(
                [
                    "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                    "-x", test_url,
                    "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    "--connect-timeout", "4",
                    "--max-time", "6",
                    "https://www.youtube.com/generate_204"
                ],
                capture_output=True,
                text=True,
                timeout=7
            )
            if res.stdout.strip() in ("204", "200"):
                self.proxy_url = f"socks5://127.0.0.1:{self.port}"
                os.environ["WARP_PROXY"] = self.proxy_url
                log_event("success", "warp:tunnel", proxy=self.proxy_url, message=f"Cloudflare WARP proxy verified active on {self.proxy_url}")
                return True
        except Exception:
            pass

        self._terminate_proc()
        return False

    def _terminate_proc(self):
        """Cleanly terminate wireproxy child process."""
        if self.proc:
            try:
                self.proc.terminate()
                self.proc.wait(timeout=2)
            except Exception:
                try:
                    self.proc.kill()
                except Exception:
                    pass
            self.proc = None
        if self.log_file and not self.log_file.closed:
            try:
                self.log_file.close()
            except Exception:
                pass
        self.log_file = None
        self.proxy_url = None

    def renew(self) -> str | None:
        """
        Force-regenerate a brand-new Cloudflare WARP account via wgcf in a fresh subfolder,
        restart wireproxy, and verify proxy connectivity.
        Returns the new proxy URL or None on failure.
        """
        log_event("info", "warp:renew", message="Regenerating Cloudflare WARP account and reconnecting tunnel...")
        self._terminate_proc()

        renew_dir = tempfile.mkdtemp(prefix="renew_", dir=self.temp_dir)
        fresh_conf = self._generate_wg_conf(work_dir=renew_dir)

        if fresh_conf and os.path.exists(fresh_conf):
            if self._start_and_verify(fresh_conf):
                log_event("success", "warp:renew", proxy=self.proxy_url, message=f"Cloudflare WARP renewed successfully: {self.proxy_url}")
                return self.proxy_url

        log_event("error", "warp:renew", message="Failed to re-establish WARP tunnel during renewal.")
        return None

    def start(self):
        """Initialize tunnel: try WARP_WG_CONF first, fallback to on-the-fly wgcf generation."""
        # 1. Check if external WARP_PROXY was already provided
        existing_proxy = os.getenv("WARP_PROXY", "").strip()
        if existing_proxy:
            self.proxy_url = existing_proxy
            log_event("info", "warp:tunnel", proxy=self.proxy_url, message=f"Using existing external WARP proxy: {self.proxy_url}")
            return

        warp_success = False

        # 2. Try WARP_WG_CONF if provided
        warp_wg_conf = os.environ.get("WARP_WG_CONF", "").strip()
        if warp_wg_conf:
            target_conf = os.path.join(self.temp_dir, "wg.conf")
            cleaned_conf = warp_wg_conf.replace("engage.cloudflareclient.com", CLOUDFLARE_WARP_IP)
            with open(target_conf, "w", encoding="utf-8") as f:
                f.write(cleaned_conf)
            os.chmod(target_conf, 0o600)
            if self._start_and_verify(target_conf):
                warp_success = True
            else:
                log_event("warn", "warp:tunnel", message="Existing WARP_WG_CONF failed health check; regenerating with wgcf...")

        # 3. Fallback: generate fresh wgcf profile
        if not warp_success:
            fresh_conf = self._generate_wg_conf()
            if fresh_conf and self._start_and_verify(fresh_conf):
                warp_success = True
            else:
                log_event("warn", "warp:tunnel", message="Fresh wgcf WARP proxy failed connectivity test")

        if not warp_success:
            log_event("info", "warp:tunnel", message="Running without WARP (direct connection)")
            self.proxy_url = None
            if "WARP_PROXY" in os.environ:
                del os.environ["WARP_PROXY"]

    def stop(self):
        """Terminate daemon and clean up temporary directory."""
        self._terminate_proc()
        shutil.rmtree(self.temp_dir, ignore_errors=True)
        if "WARP_PROXY" in os.environ:
            del os.environ["WARP_PROXY"]


def check_proxy_health(proxy_url, timeout=6):
    """Test if a rotating proxy can connect to YouTube over HTTPS."""
    try:
        res = subprocess.run(
            [
                "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                "-x", proxy_url,
                "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "--connect-timeout", str(timeout),
                "--max-time", str(timeout + 3),
                "https://www.youtube.com/generate_204"
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 4
        )
        if res.stdout.strip() in ("204", "200"):
            return proxy_url
    except Exception:
        pass
    return None


def get_live_proxies(max_needed=6):
    """Fetch and verify public HTTPS proxies from Proxifly as fallback."""
    log_event("info", "ingest:proxy", message="Fetching fresh proxies from Proxifly")
    sources = [
        ("socks5h", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt"),
        ("http", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt"),
        ("http", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt"),
    ]

    candidates = []
    for proto, url in sources:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=8) as r:
                lines = [line.decode("utf-8", errors="ignore").strip() for line in r if line.strip()]
                for line in lines:
                    if ":" in line and not line.startswith("#"):
                        clean_line = re.sub(r"^[a-zA-Z0-9]+://", "", line)
                        candidates.append(f"{proto}://{clean_line}")
        except Exception as e:
            log_event("warn", "ingest:proxy", protocol=proto, error=str(e), message=f"Could not load {proto} proxy list")

    if not candidates:
        log_event("warn", "ingest:proxy", message="No proxies retrieved from Proxifly")
        return []

    candidates = list(dict.fromkeys(candidates))
    random.shuffle(candidates)
    pool_size = min(350, len(candidates))
    test_pool = candidates[:pool_size]
    log_event("info", "ingest:proxy", test_pool_size=len(test_pool), total_candidates=len(candidates), message="Testing candidate proxies against YouTube HTTPS")

    live_proxies = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=45) as executor:
        future_to_proxy = {executor.submit(check_proxy_health, p): p for p in test_pool}
        for future in concurrent.futures.as_completed(future_to_proxy):
            try:
                verified = future.result()
                if verified:
                    live_proxies.append(verified)
                    log_event("info", "ingest:proxy", verified_proxy=verified, count=len(live_proxies), message=f"Verified YouTube HTTPS proxy: {verified}")
                    if len(live_proxies) >= max_needed:
                        for f in future_to_proxy:
                            f.cancel()
                        break
            except Exception:
                pass

    log_event("info", "ingest:proxy", selected_count=len(live_proxies), message=f"Selected {len(live_proxies)} verified proxy/proxies for download")
    return live_proxies
