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
# ==============================================================================

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

def fetch_existing_downloads(bucket_id, env, token, workdir):
    """Fetch and parse existing downloads.json manifest from HF Storage Bucket."""
    downloads_file = os.path.join(workdir, "downloads.json")
    loaded = False

    # 1. Try hf buckets cp
    try:
        res = subprocess.run(
            ["hf", "buckets", "cp", f"hf://buckets/{bucket_id}/downloads.json", downloads_file],
            env=env,
            capture_output=True,
            text=True
        )
        if res.returncode == 0 and os.path.exists(downloads_file) and os.path.getsize(downloads_file) > 0:
            print("    Loaded existing downloads.json via hf buckets cp.")
            loaded = True
    except Exception as e:
        print(f"    CLI note for downloads.json: {e}")

    # 2. Try HTTP raw / resolve endpoints
    if not loaded:
        for url in [
            f"https://huggingface.co/api/buckets/{bucket_id}/raw/downloads.json",
            f"https://huggingface.co/buckets/{bucket_id}/resolve/downloads.json",
            f"https://huggingface.co/datasets/{bucket_id}/raw/main/downloads.json",
            f"https://huggingface.co/datasets/{bucket_id}/resolve/main/downloads.json"
        ]:
            try:
                req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
                with urllib.request.urlopen(req, timeout=10) as response:
                    if response.status == 200:
                        content = response.read().decode('utf-8', errors='ignore')
                        with open(downloads_file, "w", encoding="utf-8") as f:
                            f.write(content)
                        print(f"    Loaded existing downloads.json from {url}")
                        loaded = True
                        break
            except Exception:
                pass

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
    warp_url = os.getenv("WARP_PROXY", "socks5://127.0.0.1:40000")
    if not warp_url:
        return None
    try:
        res = subprocess.run(
            [
                "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                "-x", warp_url,
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
        if "youtube.com" in clean or "youtu.be" in clean:
            # Strip query tracking parameters (?si=..., &feature=..., etc.)
            try:
                from urllib.parse import urlparse, parse_qs
                u = urlparse(clean)
                host = u.netloc.lower().replace("www.", "").replace("m.", "")
                if host == "youtu.be":
                    clean = f"https://youtu.be{u.path}"
                elif "youtube.com" in host:
                    if u.path.startswith("/shorts/"):
                        clean = f"https://www.youtube.com{u.path}"
                    elif u.path == "/watch":
                        qs = parse_qs(u.query)
                        if "v" in qs and qs["v"]:
                            clean = f"https://www.youtube.com/watch?v={qs['v'][0]}"
                        else:
                            clean = f"https://www.youtube.com{u.path}"
                    else:
                        clean = f"https://www.youtube.com{u.path}"
            except Exception:
                pass
            targets.append(clean)
        elif re.match(r"^[a-zA-Z0-9_-]{11}$", clean):
            targets.append(f"https://www.youtube.com/watch?v={clean}")
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

        uploaded = False
        try:
            cp_res = subprocess.run(
                ["hf", "buckets", "cp", downloads_file, f"hf://buckets/{bucket_id}/downloads.json"],
                env=env,
                capture_output=True,
                text=True
            )
            if cp_res.returncode == 0:
                uploaded = True
                print("    ✓ Uploaded downloads.json via hf buckets cp")
        except Exception as e:
            print(f"    hf buckets cp error: {e}")

        if not uploaded:
            try:
                from huggingface_hub import HfApi
                api = HfApi(token=token)
                api.upload_file(
                    path_or_fileobj=downloads_file,
                    path_in_repo="downloads.json",
                    repo_id=bucket_id,
                    repo_type="dataset"
                )
                uploaded = True
                print("    ✓ Uploaded downloads.json via HfApi")
            except Exception as e:
                print(f"    ✗ Failed to upload downloads.json: {e}")

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

    env = {**os.environ, "HF_TOKEN": token}

    try:
        # 1. Fetch existing ledger (all_songs.txt) from HF Storage Bucket
        print("\n--> Syncing all_songs.txt ledger from bucket...")
        ledger_loaded = False
        try:
            res_cp = subprocess.run(
                ["hf", "buckets", "cp", f"hf://buckets/{bucket_id}/all_songs.txt", archive_file],
                env=env,
                capture_output=True,
                text=True
            )
            if res_cp.returncode == 0 and os.path.exists(archive_file) and os.path.getsize(archive_file) > 0:
                print("    Loaded existing all_songs.txt via hf buckets cp.")
                ledger_loaded = True
        except Exception as e:
            print(f"    CLI note: {e}")

        if not ledger_loaded:
            for url in [
                f"https://huggingface.co/api/buckets/{bucket_id}/raw/all_songs.txt",
                f"https://huggingface.co/buckets/{bucket_id}/resolve/all_songs.txt",
                f"https://huggingface.co/datasets/{bucket_id}/raw/main/all_songs.txt",
                f"https://huggingface.co/datasets/{bucket_id}/resolve/main/all_songs.txt"
            ]:
                try:
                    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
                    with urllib.request.urlopen(req, timeout=10) as response:
                        if response.status == 200:
                            content = response.read().decode('utf-8', errors='ignore')
                            with open(archive_file, "w", encoding="utf-8") as f:
                                f.write(content)
                            print(f"    Loaded existing all_songs.txt from {url}")
                            ledger_loaded = True
                            break
                except Exception:
                    pass

        if not ledger_loaded:
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

        for target_idx, target in enumerate(targets, 1):
            # No wait on the first song; sleep 10s only between subsequent songs in a batch
            if target_idx > 1:
                print(f"\n--> Pausing 10s before next item ({target_idx}/{total_targets})...")
                time.sleep(10)

            print(f"\n==================================================")
            print(f" Ingesting Song [{target_idx}/{total_targets}]: {target}")
            print(f"==================================================")

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

        # 3. Identify downloaded media files (STRICTLY enforce requested media format)
        if media_format == "mp4":
            allowed_exts = {"mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts"}
        else:
            allowed_exts = {"m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "wma", "alac", "aiff"}

        media_files = [
            p for p in Path(workdir).iterdir()
            if p.is_file() and p.suffix.lstrip(".").lower() in allowed_exts
        ]

        if media_format != "mp4":
            video_remnants = [
                p for p in Path(workdir).iterdir()
                if p.is_file() and p.suffix.lstrip(".").lower() in {"mp4", "mkv", "webm", "avi", "mov"}
            ]
            if video_remnants:
                print(f"    Notice: Ignored {len(video_remnants)} unconverted video file(s) since audio ({media_format}) was requested: {[p.name for p in video_remnants]}")

        print(f"\n--> Download Summary:")
        print(f"    New media files downloaded: {len(media_files)}")
        for mf in media_files:
            size_mb = mf.stat().st_size / (1024 * 1024)
            print(f"      - {mf.name} ({size_mb:.2f} MB)")

        if not media_files:
            print("\nNotice: No new media files were downloaded (items may already exist in all_songs.txt).")
            return

        # 4. Enrich individual metadata JSON files & update root downloads.json manifest
        print("\n--> Processing metadata & updating downloads.json provenance manifest...")
        now_epoch = int(time.time())
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        json_files = list(Path(metadata_dir).glob("*.json"))
        json_by_stem = {jf.stem: jf for jf in json_files}

        # Load existing downloads.json manifest from HF bucket
        existing_downloads, downloads_file = fetch_existing_downloads(bucket_id, env, token, workdir)
        print(f"    Existing manifest contains {len(existing_downloads)} recorded downloads.")

        # Index existing records by filename and YouTube video ID for clean updates
        entries_by_filename = {e.get("filename"): e for e in existing_downloads if isinstance(e, dict) and e.get("filename")}
        entries_by_id = {e.get("id"): e for e in existing_downloads if isinstance(e, dict) and e.get("id")}

        for mf in media_files:
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

        # Sort manifest by ingested_at descending (newest downloads first)
        existing_downloads.sort(key=lambda x: x.get("ingested_at") or 0, reverse=True)

        with open(downloads_file, "w", encoding="utf-8") as f:
            json.dump(existing_downloads, f, indent=2, ensure_ascii=False)
        print(f"    ✓ Updated downloads.json manifest (total {len(existing_downloads)} items).")

        # 5. Upload files to Hugging Face Storage Bucket
        print(f"\n--> Uploading to Hugging Face Storage Bucket: {bucket_id}...")
        files_to_upload = []
        for mf in media_files:
            files_to_upload.append((str(mf), mf.name))
        for jf in json_files:
            files_to_upload.append((str(jf), f"metadata/{jf.name}"))
        if os.path.exists(downloads_file):
            files_to_upload.append((downloads_file, "downloads.json"))
        if os.path.exists(archive_file):
            files_to_upload.append((archive_file, "all_songs.txt"))

        uploaded_count = 0
        for local_path, remote_path in files_to_upload:
            uploaded = False
            # 1. Official CLI: hf buckets cp (High-Speed Xet S3 Storage)
            try:
                cp_res = subprocess.run(
                    ["hf", "buckets", "cp", local_path, f"hf://buckets/{bucket_id}/{remote_path}"],
                    env=env,
                    capture_output=True,
                    text=True
                )
                if cp_res.returncode == 0:
                    uploaded = True
                    print(f"    ✓ Uploaded {remote_path} via hf buckets cp")
                else:
                    err_msg = cp_res.stderr.strip() or cp_res.stdout.strip()
                    print(f"    hf buckets cp notice ({remote_path}): {err_msg[:120]}")
            except Exception as e:
                print(f"    hf buckets cp error: {e}")

            # 2. Fallback: HfApi upload_file
            if not uploaded:
                try:
                    from huggingface_hub import HfApi
                    api = HfApi(token=token)
                    api.upload_file(
                        path_or_fileobj=local_path,
                        path_in_repo=remote_path,
                        repo_id=bucket_id,
                        repo_type="dataset"
                    )
                    uploaded = True
                    print(f"    ✓ Uploaded {remote_path} via HfApi upload")
                except Exception as api_err:
                    print(f"    ✗ Failed to upload {remote_path}: {api_err}")

            if uploaded:
                uploaded_count += 1

        print(f"\n==================================================")
        print(f" Ingestion Complete!")
        print(f" Uploaded {uploaded_count}/{len(files_to_upload)} files to {bucket_id}")
        print(f"==================================================")

    finally:
        shutil.rmtree(workdir, ignore_errors=True)

if __name__ == "__main__":
    main()

