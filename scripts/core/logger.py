"""
Standard machine-readable logging and telemetry utilities for Trove.
Format: [YYYY-MM-DD] [HH:MM:SS] [LOG_LEVEL] [service:component] {"json": "payload"}
"""

import os
import re
import json
import urllib.request
from datetime import datetime, timezone

# Cloudflare Worker Telemetry Configuration
CF_WORKER_URL = os.environ.get("CF_WORKER_URL", "").strip()
CF_WORKER_TOKEN = os.environ.get("CF_WORKER_TOKEN", "").strip()
JOB_ID = os.environ.get("JOB_ID", "").strip()
GITHUB_RUN_ID = os.environ.get("GITHUB_RUN_ID", "").strip()


def log_event(level: str, service: str, **kwargs):
    """
    Standard machine-readable logger.
    Example: [2026-11-02] [15:00:04] [INFO] [ingest:download] {"status": "success", "song_id": "IImcBEHuDRI", ...}
    """
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M:%S")
    level_str = level.upper()
    body_json = json.dumps(kwargs, default=str, ensure_ascii=False)
    print(f"[{date_str}] [{time_str}] [{level_str}] [{service}] {body_json}", flush=True)


def send_telemetry_event(event: str, run_id: str = "", **kwargs):
    """Send structured lifecycle updates (run_started, item_started, item_ended, run_ended) to Cloudflare Worker."""
    if not CF_WORKER_URL or not (CF_WORKER_URL.startswith("http://") or CF_WORKER_URL.startswith("https://")):
        return
    target_endpoint = CF_WORKER_URL
    if not target_endpoint.endswith("/update") and not target_endpoint.endswith("/progress"):
        target_endpoint = target_endpoint.rstrip("/") + "/ingest/update"

    payload = {
        "event": event,
        "run_id": run_id or JOB_ID,
        "github_run_id": GITHUB_RUN_ID,
        **kwargs
    }
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Trove-Runner/1.0"
    }
    if CF_WORKER_TOKEN:
        headers["Authorization"] = f"Bearer {CF_WORKER_TOKEN}"
        headers["X-API-Key"] = CF_WORKER_TOKEN
    try:
        req = urllib.request.Request(
            target_endpoint,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=4) as resp:
            if resp.status in (200, 201, 204):
                title_or_desc = kwargs.get("title") or kwargs.get("url") or event
                log_event("info", "ingest:telemetry", event=event, target=title_or_desc, message=f"Telemetry delivered ({event})")
    except Exception as e:
        log_event("warn", "ingest:telemetry", event=event, error=str(e), message="Telemetry skipped")


def send_progress_ping(status: str, song_id: str = "", url: str = "", title: str = "", error: str = ""):
    """Backward-compatible telemetry ping wrapper."""
    event_map = {
        "started": "run_started",
        "downloading": "item_started",
        "succeeded": "item_ended",
        "failed": "item_ended",
        "completed": "run_ended"
    }
    event = event_map.get(status, status)
    send_telemetry_event(
        event=event,
        status=status,
        song_id=song_id,
        url=url,
        title=title,
        error=error
    )


def format_bytes(bytes_val):
    """Format byte integer into human-readable string (e.g. 4.25 MB)."""
    if not bytes_val or bytes_val <= 0:
        return "0 B"
    bytes_float = float(bytes_val)
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_float < 1024.0:
            return f"{bytes_float:.2f} {unit}"
        bytes_float /= 1024.0
    return f"{bytes_float:.2f} PB"


def format_duration(seconds_val):
    """Format duration in seconds into mm:ss or hh:mm:ss."""
    if not seconds_val or seconds_val <= 0:
        return "--:--"
    try:
        seconds_val = int(seconds_val)
    except (ValueError, TypeError):
        return "--:--"
    m, s = divmod(seconds_val, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def parse_targets(raw_text: str):
    """Extract, normalize, and deduplicate YouTube URLs or 11-char IDs from text."""
    targets = []
    tokens = re.split(r'[\r\n\t ]+', raw_text.strip())
    for token in tokens:
        clean = token.strip()
        if not clean or clean.startswith("#"):
            continue

        m = re.search(r'(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?(?:.*&)?v=|shorts\/|live\/))([a-zA-Z0-9_-]{11})', clean, re.IGNORECASE)
        if m:
            video_id = m.group(1)
            if "/shorts/" in clean.lower():
                clean = f"https://www.youtube.com/shorts/{video_id}"
            else:
                clean = f"https://www.youtube.com/watch?v={video_id}"
            targets.append(clean)
        elif re.match(r"^[a-zA-Z0-9_-]{11}$", clean):
            targets.append(f"https://www.youtube.com/watch?v={clean}")
        elif "youtube.com" in clean or "youtu.be" in clean:
            clean = re.sub(r'[?&](?:si|feature|pp)=[^&\s]+', '', clean)
            if not clean.startswith("http://") and not clean.startswith("https://"):
                clean = f"https://{clean}"
            targets.append(clean)
        elif clean.startswith("http://") or clean.startswith("https://"):
            targets.append(clean)
        else:
            targets.append(f"https://www.youtube.com/watch?v={clean}")

    seen = set()
    deduped = []
    for t in targets:
        if t not in seen:
            seen.add(t)
            deduped.append(t)
    return deduped

