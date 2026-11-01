#!/usr/bin/env python3
"""
Trove Media Ingest Script for GitHub Actions / Local Execution.
Downloads media from YouTube with yt-dlp, extracts metadata & thumbnails,
and uploads directly to Hugging Face Storage Bucket.
"""

import os
import sys
import re
import time
import json
import shutil
import random
import tempfile
import subprocess
import concurrent.futures
from pathlib import Path
import urllib.request
from datetime import datetime, timezone

# ==============================================================================
# Ingestion Configuration Toggles
# ==============================================================================
# Client prioritization for yt-dlp
YOUTUBE_PLAYER_CLIENTS = os.getenv("YOUTUBE_PLAYER_CLIENTS", "android,ios,mweb,tv,web")

# Toggle whether to fall back to rotating proxies when direct download fails (Default: False)
ENABLE_PROXY_FALLBACK = os.getenv("ENABLE_PROXY_FALLBACK", "false").lower() in ("true", "1", "yes")

# Maximum proxy attempts per song if proxy fallback is enabled
MAX_PROXY_ATTEMPTS = int(os.getenv("MAX_PROXY_ATTEMPTS", "5"))

# Number of songs to download before incrementally pushing to Hugging Face (Default: 3)
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "3"))

# Cloudflare Worker Telemetry & Job Tracking
CF_WORKER_URL = os.environ.get("CF_WORKER_URL", "").strip()
CF_WORKER_TOKEN = os.environ.get("CF_WORKER_TOKEN", "").strip()
JOB_ID = os.environ.get("JOB_ID", "").strip()
GITHUB_RUN_ID = os.environ.get("GITHUB_RUN_ID", "").strip()

def send_progress_ping(status: str, song_id: str = "", url: str = "", title: str = "", error: str = ""):
    """Send non-blocking progress telemetry to Cloudflare Worker."""
    if not CF_WORKER_URL or not (CF_WORKER_URL.startswith("http://") or CF_WORKER_URL.startswith("https://")):
        return
    target_endpoint = CF_WORKER_URL
    if not target_endpoint.endswith("/progress") and not target_endpoint.endswith("/event"):
        target_endpoint = target_endpoint.rstrip("/") + "/ingest/progress"
    payload = {
        "job_id": JOB_ID,
        "run_id": GITHUB_RUN_ID,
        "song_id": song_id,
        "url": url,
        "title": title,
        "status": status,
        "error": error
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
                print(f"    ✓ [Telemetry] Ping delivered ({status}): {title or url or status}")
    except Exception as e:
        print(f"    Notice: Telemetry ping ({status}) to {target_endpoint} skipped: {e}")
# ==============================================================================

def upload_file_to_hf(local_path: str, remote_path: str, bucket_id: str, env: dict, token: str) -> bool:
    """Upload a single file to Hugging Face Storage Bucket using hf buckets cp with HfApi fallback."""
    # 1. Official CLI: hf buckets cp (High-Speed Xet S3 Storage)
    try:
        cp_res = subprocess.run(
            ["hf", "buckets", "cp", local_path, f"hf://buckets/{bucket_id}/{remote_path}"],
            env=env,
            capture_output=True,
            text=True
        )
        if cp_res.returncode == 0:
            print(f"    ✓ Uploaded {remote_path} via hf buckets cp")
            return True
        else:
            err_msg = cp_res.stderr.strip() or cp_res.stdout.strip()
            print(f"    hf buckets cp notice ({remote_path}): {err_msg[:120]}")
    except Exception as e:
        print(f"    hf buckets cp error: {e}")

    # 2. Fallback: HfApi upload_file
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
        api.upload_file(
            path_or_fileobj=local_path,
            path_in_repo=remote_path,
            repo_id=bucket_id,
            repo_type="dataset"
        )
        print(f"    ✓ Uploaded {remote_path} via HfApi upload")
        return True
    except Exception as api_err:
        print(f"    ✗ Failed to upload {remote_path}: {api_err}")
        return False

def format_bytes_py(bytes_val):
    """Format byte integer into human-readable string (e.g. 4.25 MB)."""
    if not bytes_val or bytes_val <= 0:
        return "0 B"
    bytes_float = float(bytes_val)
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if bytes_float < 1024.0:
            return f"{bytes_float:.2f} {unit}"
        bytes_float /= 1024.0
    return f"{bytes_float:.2f} PB"

def format_duration_py(seconds_val):
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

def fetch_file_from_hf(remote_path: str, local_path: str, bucket_id: str, token: str, env: dict) -> bool:
    """Fast-fetch a remote file from Hugging Face bucket via direct HTTP GET, falling back to hf buckets cp."""
    # 1. Direct HTTP GET (fastest, ~150ms, avoids subprocess startup overhead)
    urls = [
        f"https://huggingface.co/api/buckets/{bucket_id}/raw/{remote_path}",
        f"https://huggingface.co/buckets/{bucket_id}/resolve/{remote_path}",
        f"https://huggingface.co/datasets/{bucket_id}/raw/main/{remote_path}",
        f"https://huggingface.co/datasets/{bucket_id}/resolve/main/{remote_path}"
    ]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    with open(local_path, "wb") as f:
                        f.write(resp.read())
                    return True
        except urllib.error.HTTPError as he:
            if he.code == 404:
                return False
        except Exception:
            pass

    # 2. Fallback to hf buckets cp CLI
    try:
        res = subprocess.run(
            ["hf", "buckets", "cp", f"hf://buckets/{bucket_id}/{remote_path}", local_path],
            env=env,
            capture_output=True,
            text=True,
            timeout=10
        )
        if res.returncode == 0 and os.path.exists(local_path) and os.path.getsize(local_path) > 0:
            return True
    except Exception:
        pass

    return False

def fetch_existing_downloads(bucket_id, env, token, workdir):
    """Fetch and parse existing downloads.json manifest from HF Storage Bucket."""
    downloads_file = os.path.join(workdir, "downloads.json")
    loaded = fetch_file_from_hf("downloads.json", downloads_file, bucket_id, token, env)

    if loaded and os.path.exists(downloads_file):
        try:
            with open(downloads_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data, downloads_file
                elif isinstance(data, dict) and "downloads" in data and isinstance(data["downloads"], list):
                    return data["downloads"], downloads_file
        except Exception as e:
            print(f"    Notice: could not parse existing downloads.json ({e}). Starting fresh.")

    return [], downloads_file

def get_warp_proxy():
    """Check if Cloudflare WARP SOCKS5 proxy is active and reachable."""
    env_proxy = os.getenv("WARP_PROXY")
    # If run-with-warp already tested and exported WARP_PROXY, trust it directly (saves ~1.5s)
    if env_proxy is not None:
        return env_proxy if env_proxy.strip() else None

    # Fallback check for local development or manual runs
    warp_url = "socks5://127.0.0.1:40000"
    try:
        res = subprocess.run(
            [
                "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                "-x", warp_url,
                "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                "--connect-timeout", "2",
                "--max-time", "3",
                "https://www.youtube.com/generate_204"
            ],
            capture_output=True,
            text=True,
            timeout=4
        )
        if res.stdout.strip() in ("204", "200"):
            return warp_url
    except Exception:
        pass
    return None

def check_proxy_health(proxy_url, timeout=6):
    """
    Test if a proxy can connect to YouTube over HTTPS and receive a valid response.
    Tests against YouTube's lightweight connectivity ping endpoint (generate_204)
    using a realistic browser User-Agent so Google/YouTube does not reject curl.
    """
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
        code = res.stdout.strip()
        if code in ("204", "200"):
            return proxy_url
    except Exception:
        pass
    return None

def get_live_proxies(max_needed=6):
    """Fetch fresh proxies from Proxifly and verify them directly against YouTube HTTPS."""
    print("\n--> Fetching fresh proxies from Proxifly (updated every 5 mins)...")
    # Open proxies that support CONNECT tunneling must use http:// or socks5h:// prefixes.
    # Note: 'https://' prefix in curl/yt-dlp expects TLS to the proxy itself (which public proxies don't support).
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
                        # Normalize to http:// or socks5h://
                        clean_line = re.sub(r"^[a-zA-Z0-9]+://", "", line)
                        candidates.append(f"{proto}://{clean_line}")
        except Exception as e:
            print(f"    Notice: could not load {proto} list: {e}")

    if not candidates:
        print("    No proxies retrieved from Proxifly.")
        return []

    # Deduplicate and randomly sample
    candidates = list(dict.fromkeys(candidates))
    random.shuffle(candidates)
    pool_size = min(350, len(candidates))
    test_pool = candidates[:pool_size]
    print(f"    Testing pool of {len(test_pool)} candidates directly against YouTube HTTPS (total pool: {len(candidates)})...")

    live_proxies = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=45) as executor:
        future_to_proxy = {executor.submit(check_proxy_health, p): p for p in test_pool}
        for future in concurrent.futures.as_completed(future_to_proxy):
            try:
                verified_proxy = future.result()
                if verified_proxy:
                    live_proxies.append(verified_proxy)
                    print(f"    ✓ Verified YouTube HTTPS proxy: {verified_proxy}")
                    if len(live_proxies) >= max_needed:
                        # Cancel remaining pending checks once we hit our quota
                        for f in future_to_proxy:
                            f.cancel()
                        break
            except Exception:
                pass

    print(f"    Selected {len(live_proxies)} verified proxy/proxies for download.")
    return live_proxies

def parse_targets(raw_text: str):
    targets = []
    # Split by whitespace or newlines
    tokens = re.split(r'[\r\n\t ]+', raw_text.strip())
    for token in tokens:
        clean = token.strip()
        if not clean or clean.startswith("#"):
            continue

        # Extract 11-char video ID if present (strips all tracking params like ?si=..., &feature=..., etc.)
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
            # Strip query params like ?si=..., &feature=..., etc.
            clean = re.sub(r'[?&](?:si|feature|pp)=[^&\s]+', '', clean)
            if not clean.startswith("http://") and not clean.startswith("https://"):
                clean = f"https://{clean}"
            targets.append(clean)
        elif clean.startswith("http://") or clean.startswith("https://"):
            targets.append(clean)
        else:
            targets.append(f"https://www.youtube.com/watch?v={clean}")
    # Deduplicate while preserving order
    seen = set()
    deduped = []
    for t in targets:
        if t not in seen:
            seen.add(t)
            deduped.append(t)
    return deduped

def backfill_manifest(bucket_id: str, token: str):
    """Scan existing files and metadata in the bucket to construct or backfill downloads.json."""
    print("==================================================")
    print(" Trove Manifest Backfill")
    print(f" HF Bucket: {bucket_id}")
    print("==================================================")
    
    env = {**os.environ, "HF_TOKEN": token}
    workdir = tempfile.mkdtemp(prefix="trove_backfill_")
    downloads_file = os.path.join(workdir, "downloads.json")

    try:
        # 1. Fetch file list from bucket
        file_list = []
        try:
            from huggingface_hub import HfApi
            api = HfApi(token=token)
            file_list = api.list_repo_files(repo_id=bucket_id, repo_type="dataset")
        except Exception as e:
            print(f"    Notice: HfApi list_repo_files: {e}")

        if not file_list:
            # Fallback to tree API
            try:
                tree_url = f"https://huggingface.co/api/buckets/{bucket_id}/tree?recursive=true"
                req = urllib.request.Request(tree_url, headers={"Authorization": f"Bearer {token}"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    tree_data = json.load(resp)
                    for item in tree_data:
                        p = item.get("path") or item.get("rfilename")
                        if p:
                            file_list.append(p)
            except Exception as e:
                print(f"    Notice: Bucket tree fallback: {e}")

        if not file_list:
            print("ERROR: Could not retrieve file list from bucket.")
            return

        print(f"    Discovered {len(file_list)} total entries in bucket.")

        # Identify media files
        audio_video_exts = {"m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "mp4", "mkv", "webm"}
        media_paths = [
            f for f in file_list 
            if "." in f and f.split(".")[-1].lower() in audio_video_exts and not f.startswith("metadata/")
        ]
        metadata_paths = {
            Path(f).stem: f for f in file_list 
            if f.startswith("metadata/") and f.endswith(".json")
        }

        print(f"    Found {len(media_paths)} media files and {len(metadata_paths)} metadata records.")

        # Fetch existing downloads.json
        existing_downloads, _ = fetch_existing_downloads(bucket_id, env, token, workdir)
        entries_by_filename = {e.get("filename"): e for e in existing_downloads if isinstance(e, dict) and e.get("filename")}
        entries_by_id = {e.get("id"): e for e in existing_downloads if isinstance(e, dict) and e.get("id")}

        now_epoch = int(time.time())
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        backfilled_count = 0
        for mp in media_paths:
            filename = Path(mp).name
            stem = Path(mp).stem
            file_format = Path(mp).suffix.lstrip(".").lower()
            meta_path = metadata_paths.get(stem)

            data = {}
            if meta_path:
                meta_url = f"https://huggingface.co/api/buckets/{bucket_id}/raw/{meta_path}"
                try:
                    req = urllib.request.Request(meta_url, headers={"Authorization": f"Bearer {token}"})
                    with urllib.request.urlopen(req, timeout=8) as resp:
                        data = json.load(resp)
                except Exception:
                    pass

            video_id = data.get("id") or ""
            title = data.get("title") or stem
            artist = data.get("artist") or data.get("creator") or data.get("uploader") or data.get("channel") or ""
            album = data.get("album") or ""
            duration_sec = int(data.get("duration") or 0)
            size_bytes = int(data.get("trove_media_bytes") or data.get("filesize") or 0)
            youtube_url = data.get("webpage_url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else "")
            thumbnail_url = data.get("thumbnail") or ""
            tags = data.get("tags") or []
            genre = data.get("genre") or ""
            ingested_at = data.get("trove_ingested_at") or now_epoch
            ingested_at_iso = data.get("trove_ingested_at_iso") or now_iso

            entry = {
                "id": video_id,
                "filename": filename,
                "path": mp,
                "metadata_path": meta_path or "",
                "title": title,
                "artist": artist,
                "album": album,
                "duration": format_duration_py(duration_sec),
                "duration_seconds": duration_sec,
                "size_bytes": size_bytes,
                "size_formatted": format_bytes_py(size_bytes),
                "format": file_format,
                "youtube_url": youtube_url,
                "thumbnail_url": thumbnail_url,
                "tags": tags,
                "genre": genre,
                "ingested_at": ingested_at,
                "ingested_at_iso": ingested_at_iso
            }

            if filename in entries_by_filename:
                entries_by_filename[filename].update(entry)
            elif video_id and video_id in entries_by_id:
                entries_by_id[video_id].update(entry)
            else:
                existing_downloads.append(entry)
                entries_by_filename[filename] = entry
                if video_id:
                    entries_by_id[video_id] = entry
            backfilled_count += 1

        existing_downloads.sort(key=lambda x: x.get("ingested_at") or 0, reverse=True)

        with open(downloads_file, "w", encoding="utf-8") as f:
            json.dump(existing_downloads, f, indent=2, ensure_ascii=False)

        print(f"    Built downloads.json with {len(existing_downloads)} entries ({backfilled_count} scanned).")
        print(f"--> Uploading downloads.json to {bucket_id}...")

        uploaded = upload_file_to_hf(downloads_file, "downloads.json", bucket_id, env, token)

        print("==================================================")
        print(" Backfill Complete!")
        print("==================================================")
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

def main():
    bucket_id = os.environ.get("BUCKET_ID", "mnswa/trove_dataset").strip()
    token = os.environ.get("HF_TOKEN") or os.environ.get("INPUT_HF_TOKEN") or ""
    token = token.strip()

    if not token:
        print("ERROR: No Hugging Face token found. Set HF_TOKEN env variable or secret.")
        sys.exit(1)

    is_backfill = "--backfill" in sys.argv or os.environ.get("BACKFILL", "").lower() in ("true", "1", "yes")
    if is_backfill:
        backfill_manifest(bucket_id, token)
        return

    raw_targets = os.environ.get("TARGETS", "").strip()
    media_format = os.environ.get("MEDIA_FORMAT", "m4a").strip().lower()

    if not raw_targets:
        print("ERROR: No targets provided. Set TARGETS env variable.")
        sys.exit(1)

    targets = parse_targets(raw_targets)
    if not targets:
        print("ERROR: No valid YouTube URLs or IDs found.")
        sys.exit(1)

    print(f"==================================================")
    print(f" Trove Media Ingestion")
    print(f" Targets:    {len(targets)}")
    print(f" Format:     {media_format.upper()}")
    print(f" HF Bucket:  {bucket_id}")
    print(f"==================================================")

    # Use dedicated working directory
    workdir = tempfile.mkdtemp(prefix="trove_ingest_")
    metadata_dir = os.path.join(workdir, "metadata")
    os.makedirs(metadata_dir, exist_ok=True)
    archive_file = os.path.join(workdir, "all_songs.txt")

    start_epoch = int(time.time())
    start_time_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    start_time_slug = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    target_results = []

    # Send initial started telemetry ping to Cloudflare Worker
    send_progress_ping("started", title=f"Ingestion started for {len(targets)} item(s)")

    env = {**os.environ, "HF_TOKEN": token}

    try:
        # 1. Fetch existing ledger (all_songs.txt) from HF Storage Bucket
        print("\n--> Syncing all_songs.txt ledger from bucket...")
        ledger_loaded = fetch_file_from_hf("all_songs.txt", archive_file, bucket_id, token, env)
        if ledger_loaded:
            print("    ✓ Loaded existing all_songs.txt from bucket.")
        else:
            Path(archive_file).touch()
            print("    No existing ledger found. Created empty all_songs.txt.")

        before_lines = 0
        if os.path.exists(archive_file):
            with open(archive_file, "r", encoding="utf-8") as f:
                before_lines = sum(1 for line in f if line.strip())
        print(f"    Ledger currently contains {before_lines} song entries.")

        # 2. Run yt-dlp
        print(f"\n--> Running yt-dlp to download media ({media_format})...")
        out_template = os.path.join(workdir, "%(title)s.%(ext)s")
        meta_template = os.path.join(metadata_dir, "%(title)s.json")

        base_cmd = [
            "yt-dlp",
            "--verbose",
            "--force-ipv4",
            "--download-archive", archive_file,
            "--embed-thumbnail",
            "--add-metadata",
            "--print-to-file",
            "%(.{title,artist,creator,channel,uploader,album,album_artist,release_date,upload_date,duration,track,track_number,genre,description,thumbnail,id,webpage_url,tags,filesize})j",
            meta_template,
            "-o", out_template,
            "--remote-components", "ejs:github",
            "--extractor-args", f"youtube:player_client={YOUTUBE_PLAYER_CLIENTS}",
            "--print", "before_dl:[%(epoch>%Y-%m-%d %H:%M:%S)s] Downloading: %(title)s.%(ext)s",
            "--print", "after_move:[%(epoch>%Y-%m-%d %H:%M:%S)s] Success: %(title)s.%(ext)s"
        ]

        if media_format == "mp4":
            base_cmd.extend(["-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4"])
        else:
            # Prioritize native AAC audio stream (m4a) directly; fallback to best audio or combined stream with ffmpeg extraction
            base_cmd.extend(["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a", "--audio-quality", "0"])

        # Explicitly pass ffmpeg directory to yt-dlp if detected
        ffmpeg_bin = shutil.which("ffmpeg")
        if ffmpeg_bin:
            base_cmd.extend(["--ffmpeg-location", os.path.dirname(ffmpeg_bin)])

        total_targets = len(targets)
        live_proxies = None  # Lazily fetch only if a target fails direct download
        successful_targets = 0

        # Detect Cloudflare WARP SOCKS5 tunnel
        warp_proxy = get_warp_proxy()
        if warp_proxy:
            print(f"\n--> [Network] Cloudflare WARP SOCKS5 tunnel active on {warp_proxy}.")
            print("    Routing YouTube downloads through Cloudflare's global edge network.")
            base_cmd.extend(["--proxy", warp_proxy])
        else:
            print("\n--> [Network] Direct connection (Cloudflare WARP not detected).")

        # Load existing downloads manifest once at start
        existing_downloads, downloads_file = fetch_existing_downloads(bucket_id, env, token, workdir)
        print(f"    Existing manifest contains {len(existing_downloads)} recorded downloads.")
        entries_by_filename = {e.get("filename"): e for e in existing_downloads if isinstance(e, dict) and e.get("filename")}
        entries_by_id = {e.get("id"): e for e in existing_downloads if isinstance(e, dict) and e.get("id")}

        if media_format == "mp4":
            allowed_exts = {"mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts"}
        else:
            allowed_exts = {"m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "wma", "alac", "aiff"}

        uploaded_media_paths = set()
        uploaded_meta_paths = set()
        total_uploaded = 0
        chunk_number = 0

        def get_pending_media():
            return [
                p for p in Path(workdir).iterdir()
                if p.is_file() and p.suffix.lstrip(".").lower() in allowed_exts and str(p) not in uploaded_media_paths
            ]

        def flush_chunk(reason="chunk"):
            nonlocal total_uploaded, chunk_number
            pending = get_pending_media()
            if not pending:
                return 0

            chunk_number += 1
            print(f"\n==================================================")
            print(f" [Chunk #{chunk_number}] Pushing {len(pending)} song(s) to Hugging Face ({reason})...")
            print(f"==================================================")

            now_epoch = int(time.time())
            now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

            json_files = list(Path(metadata_dir).glob("*.json"))
            json_by_stem = {jf.stem: jf for jf in json_files}

            files_to_push = []

            for mf in pending:
                size_bytes = mf.stat().st_size
                file_format = mf.suffix.lstrip(".").lower()
                jf = json_by_stem.get(mf.stem)

                data = {}
                if jf and jf.exists():
                    try:
                        with open(jf, "r", encoding="utf-8") as f:
                            data = json.load(f)
                    except Exception as e:
                        print(f"    Notice reading metadata {jf.name}: {e}")

                # Enforce rich download provenance fields in individual metadata JSON
                data["trove_ingested_at"] = now_epoch
                data["trove_ingested_at_iso"] = now_iso
                data["trove_media_file"] = mf.name
                data["trove_media_format"] = file_format
                data["trove_media_bytes"] = size_bytes
                data["trove_media_size"] = format_bytes_py(size_bytes)
                data["trove_duration_formatted"] = format_duration_py(data.get("duration"))
                data["trove_source"] = "youtube"
                data["trove_bucket"] = bucket_id
                data["trove_version"] = "1.0"

                if jf:
                    try:
                        with open(jf, "w", encoding="utf-8") as f:
                            json.dump(data, f, indent=2, ensure_ascii=False)
                    except Exception as e:
                        print(f"    Warning formatting {jf.name}: {e}")

                # Extract fields for root downloads.json manifest
                video_id = data.get("id") or ""
                title = data.get("title") or mf.stem
                artist = data.get("artist") or data.get("creator") or data.get("uploader") or data.get("channel") or ""
                album = data.get("album") or ""
                duration_sec = int(data.get("duration") or 0)
                youtube_url = data.get("webpage_url") or (f"https://www.youtube.com/watch?v={video_id}" if video_id else "")
                thumbnail_url = data.get("thumbnail") or ""
                tags = data.get("tags") or []
                genre = data.get("genre") or ""

                manifest_entry = {
                    "id": video_id,
                    "filename": mf.name,
                    "path": mf.name,
                    "metadata_path": f"metadata/{jf.name}" if jf else "",
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "duration": format_duration_py(duration_sec),
                    "duration_seconds": duration_sec,
                    "size_bytes": size_bytes,
                    "size_formatted": format_bytes_py(size_bytes),
                    "format": file_format,
                    "youtube_url": youtube_url,
                    "thumbnail_url": thumbnail_url,
                    "tags": tags,
                    "genre": genre,
                    "ingested_at": now_epoch,
                    "ingested_at_iso": now_iso
                }

                if mf.name in entries_by_filename:
                    entries_by_filename[mf.name].update(manifest_entry)
                elif video_id and video_id in entries_by_id:
                    entries_by_id[video_id].update(manifest_entry)
                else:
                    existing_downloads.append(manifest_entry)
                    entries_by_filename[mf.name] = manifest_entry
                    if video_id:
                        entries_by_id[video_id] = manifest_entry

                files_to_push.append((str(mf), mf.name, "media"))
                if jf and str(jf) not in uploaded_meta_paths:
                    files_to_push.append((str(jf), f"metadata/{jf.name}", "meta"))

            # Sort manifest by ingested_at descending (newest downloads first)
            existing_downloads.sort(key=lambda x: x.get("ingested_at") or 0, reverse=True)

            with open(downloads_file, "w", encoding="utf-8") as f:
                json.dump(existing_downloads, f, indent=2, ensure_ascii=False)

            files_to_push.append((downloads_file, "downloads.json", "manifest"))
            if os.path.exists(archive_file):
                files_to_push.append((archive_file, "all_songs.txt", "ledger"))

            chunk_uploaded = 0

            def _push_worker(item):
                l_path, r_path, ftype = item
                ok = upload_file_to_hf(l_path, r_path, bucket_id, env, token)
                return item, ok

            # Upload media, metadata, manifest, and ledger concurrently (saves ~4-8s)
            max_workers = min(4, len(files_to_push))
            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                for (local_path, remote_path, ftype), success in executor.map(_push_worker, files_to_push):
                    if success:
                        if ftype == "media":
                            uploaded_media_paths.add(local_path)
                            chunk_uploaded += 1
                            # Clean up local media file to conserve runner disk space
                            try:
                                os.remove(local_path)
                            except Exception:
                                pass
                        elif ftype == "meta":
                            uploaded_meta_paths.add(local_path)

            total_uploaded += chunk_uploaded
            print(f"    ✓ Chunk #{chunk_number} complete: {chunk_uploaded} media file(s) uploaded. (Total library entries: {len(existing_downloads)})")
            return chunk_uploaded

        for target_idx, target in enumerate(targets, 1):
            # No wait on the first song; sleep 10s only between subsequent songs in a batch
            if target_idx > 1:
                print(f"\n--> Pausing 10s before next item ({target_idx}/{total_targets})...")
                time.sleep(10)

            print(f"\n==================================================")
            print(f" Ingesting Song [{target_idx}/{total_targets}]: {target}")
            print(f"==================================================")

            send_progress_ping("downloading", url=target, title=f"Downloading [{target_idx}/{total_targets}]")

            target_success = False

            # 1. Attempt Direct Download first (Fastest; Android/iOS clients + Deno)
            print(f"--> [Attempt 1] Direct Download (Fastest, High-Speed Connection)...")
            direct_cmd = list(base_cmd)
            direct_cmd.extend(["--socket-timeout", "15", "--retries", "1", "--extractor-retries", "1", target])
            proc = subprocess.run(direct_cmd, text=True)

            if proc.returncode == 0:
                print(f"    ✓ Direct download succeeded for {target}!")
                target_success = True
            else:
                print(f"    Note: Direct download completed with exit code {proc.returncode}.")

                if ENABLE_PROXY_FALLBACK:
                    print("    Switching to rotating verified proxies from Proxifly...")
                    # 2. Proxy Fallback (Lazily fetched once)
                    if live_proxies is None:
                        live_proxies = get_live_proxies(max_needed=MAX_PROXY_ATTEMPTS)

                    if live_proxies:
                        for attempt_idx, proxy in enumerate(live_proxies, 1):
                            print(f"\n--> [Proxy Attempt {attempt_idx}/{len(live_proxies)}] Testing with: {proxy}...")
                            proxy_cmd = list(base_cmd)
                            # Resilient timeout (15s) and 2 retries to absorb network proxy latency
                            proxy_cmd.extend([
                                "--socket-timeout", "15",
                                "--retries", "2",
                                "--extractor-retries", "2",
                                "--fragment-retries", "2",
                                "--proxy", proxy,
                                target
                            ])

                            proc_proxy = subprocess.run(proxy_cmd, text=True)
                            if proc_proxy.returncode == 0:
                                print(f"    ✓ Download succeeded using proxy: {proxy}!")
                                target_success = True
                                break
                            else:
                                print(f"    ✗ Proxy {proxy} exited with code {proc_proxy.returncode}. Moving to next proxy...")
                else:
                    print("    Proxy fallback is disabled (ENABLE_PROXY_FALLBACK = False). Skipping proxies.")

                if not target_success:
                    print(f"    ✗ All download attempts failed for {target}.")

            if target_success:
                successful_targets += 1

                # Extract song title and details for report & telemetry
                song_title = ""
                song_id = ""
                file_format = media_format
                size_bytes = 0
                pending_now = get_pending_media()
                if pending_now:
                    latest_media = pending_now[-1]
                    size_bytes = latest_media.stat().st_size
                    file_format = latest_media.suffix.lstrip(".").lower()
                    meta_file = Path(metadata_dir) / f"{latest_media.stem}.json"
                    if meta_file.exists():
                        try:
                            with open(meta_file, "r", encoding="utf-8") as mf:
                                mdata = json.load(mf)
                                song_title = mdata.get("title") or latest_media.stem
                                song_id = mdata.get("id") or ""
                        except Exception:
                            pass
                    if not song_title:
                        song_title = latest_media.stem

                target_results.append({
                    "id": song_id,
                    "url": target,
                    "title": song_title or target,
                    "format": file_format,
                    "size_bytes": size_bytes,
                    "size_formatted": format_bytes_py(size_bytes),
                    "status": "success"
                })

                send_progress_ping(
                    "succeeded",
                    song_id=song_id,
                    url=target,
                    title=song_title or target
                )

                # Check if buffer has reached CHUNK_SIZE
                if len(pending_now) >= CHUNK_SIZE:
                    flush_chunk(reason=f"Reached threshold of {CHUNK_SIZE} songs")
            else:
                err_msg = "Download failed (sign in or unavailable)"
                target_results.append({
                    "id": "",
                    "url": target,
                    "title": target,
                    "status": "failed",
                    "error": err_msg
                })
                send_progress_ping("failed", url=target, title=target, error=err_msg)

        # Flush any remaining items in the final chunk
        pending_remaining = get_pending_media()
        if pending_remaining:
            flush_chunk(reason="Final remaining songs in batch")

        # 3. Compile and upload permanent Ingestion Report to HF (ingests/ingest_{start_time_slug}.json)
        end_time_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        duration_sec = int(time.time() - start_epoch)
        report_data = {
            "job_id": JOB_ID,
            "run_id": GITHUB_RUN_ID,
            "start_time": start_time_iso,
            "end_time": end_time_iso,
            "duration_seconds": duration_sec,
            "warp_used": bool(warp_proxy),
            "format": media_format,
            "bucket_id": bucket_id,
            "summary": {
                "total": total_targets,
                "successful": successful_targets,
                "failed": total_targets - successful_targets
            },
            "results": target_results
        }
        report_local = os.path.join(workdir, f"ingest_{start_time_slug}.json")
        try:
            with open(report_local, "w", encoding="utf-8") as rf:
                json.dump(report_data, rf, indent=2, ensure_ascii=False)
            remote_report_path = f"ingests/ingest_{start_time_slug}.json"
            print(f"\n--> Uploading permanent ingestion report to {remote_report_path}...")
            upload_file_to_hf(report_local, remote_report_path, bucket_id, env, token)
        except Exception as report_err:
            print(f"    Warning: Could not upload ingestion report: {report_err}")

        # Send final completed telemetry ping
        send_progress_ping(
            "completed",
            title=f"Finished: {successful_targets}/{total_targets} succeeded"
        )

        if total_uploaded == 0 and successful_targets == 0:
            print("\nNotice: No new media files were downloaded (items may already exist in all_songs.txt).")
            return

        print(f"\n==================================================")
        print(f" Ingestion Complete!")
        print(f" Targets processed: {total_targets}")
        print(f" Successful downloads: {successful_targets}")
        print(f" Media files uploaded to {bucket_id}: {total_uploaded}")
        print(f"==================================================")

    finally:
        shutil.rmtree(workdir, ignore_errors=True)

if __name__ == "__main__":
    main()

