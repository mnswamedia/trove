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

def main():
    raw_targets = os.environ.get("TARGETS", "").strip()
    media_format = os.environ.get("MEDIA_FORMAT", "m4a").strip().lower()
    bucket_id = os.environ.get("BUCKET_ID", "mnswa/trove_dataset").strip()
    token = os.environ.get("HF_TOKEN") or os.environ.get("INPUT_HF_TOKEN") or ""
    token = token.strip()

    if not raw_targets:
        print("ERROR: No targets provided. Set TARGETS env variable.")
        sys.exit(1)

    if not token:
        print("ERROR: No Hugging Face token found. Set HF_TOKEN env variable or secret.")
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
                f"https://huggingface.co/buckets/{bucket_id}/resolve/all_songs.txt"
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
            # ba/b ensures resilient fallback to standard stream if pure audio-only DASH is unavailable
            base_cmd.extend(["-f", "ba/b", "-x", "--audio-format", "m4a"])

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

        # 3. Format metadata JSON files (indent=2)
        print("\n--> Formatting extracted metadata JSON files...")
        json_files = list(Path(metadata_dir).glob("*.json"))
        for jf in json_files:
            try:
                with open(jf, "r", encoding="utf-8") as f:
                    data = json.load(f)
                with open(jf, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
            except Exception as e:
                print(f"    Warning formatting {jf.name}: {e}")
        print(f"    Formatted {len(json_files)} metadata files.")

        # 4. Identify downloaded media files (STRICTLY audio/video extensions only)
        MEDIA_EXTENSIONS = {
            "m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "wma", "alac", "aiff",
            "mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts"
        }
        media_files = [
            p for p in Path(workdir).iterdir()
            if p.is_file() and p.suffix.lstrip(".").lower() in MEDIA_EXTENSIONS
        ]

        print(f"\n--> Download Summary:")
        print(f"    New media files downloaded: {len(media_files)}")
        for mf in media_files:
            size_mb = mf.stat().st_size / (1024 * 1024)
            print(f"      - {mf.name} ({size_mb:.2f} MB)")

        if not media_files:
            print("\nNotice: No new media files were downloaded (items may already exist in all_songs.txt).")
            return

        # 5. Upload files to Hugging Face Storage Bucket
        print(f"\n--> Uploading to Hugging Face Storage Bucket: {bucket_id}...")
        files_to_upload = []
        for mf in media_files:
            files_to_upload.append((str(mf), mf.name))
        for jf in json_files:
            files_to_upload.append((str(jf), f"metadata/{jf.name}"))
        if os.path.exists(archive_file):
            files_to_upload.append((archive_file, "all_songs.txt"))

        uploaded_count = 0
        for local_path, remote_path in files_to_upload:
            uploaded = False
            # 1. Try hf buckets cp
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
                    print(f"    hf buckets cp note ({remote_path}): {cp_res.stderr.strip() or cp_res.stdout.strip()}")
            except Exception as e:
                print(f"    hf buckets cp error: {e}")

            # 2. Fallback to HfApi upload_file
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
                    print(f"    ✓ Uploaded {remote_path} via HfApi dataset upload")
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

