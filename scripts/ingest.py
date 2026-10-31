#!/usr/bin/env python3
"""
Trove Media Ingest Script for GitHub Actions / Local Execution.
Downloads media from YouTube with yt-dlp, extracts metadata & thumbnails,
and uploads directly to Hugging Face Storage Bucket.
"""

import os
import sys
import re
import json
import shutil
import random
import tempfile
import subprocess
import concurrent.futures
from pathlib import Path
import urllib.request

def check_proxy_health(proxy_url, timeout=3):
    """Test if a proxy can connect to Google/YouTube in under 3 seconds."""
    try:
        res = subprocess.run(
            [
                "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                "-x", proxy_url,
                "--connect-timeout", str(timeout),
                "--max-time", str(timeout + 2),
                "https://www.google.com/generate_204"
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 3
        )
        code = res.stdout.strip()
        if code in ("200", "204", "301", "302"):
            return proxy_url
    except Exception:
        pass
    return None

def get_live_proxies(max_needed=5):
    """Fetch 5-minute fresh proxies from Proxifly and verify live ones."""
    print("\n--> Fetching fresh proxies from Proxifly (updated every 5 mins)...")
    sources = [
        ("socks5", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/socks5/data.txt"),
        ("https", "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt"),
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
                        candidates.append(f"{proto}://{line}")
        except Exception as e:
            print(f"    Notice: could not load {proto} list: {e}")

    if not candidates:
        print("    No proxies retrieved from Proxifly.")
        return []

    # Deduplicate and randomly sample a test pool of 35 proxies
    candidates = list(dict.fromkeys(candidates))
    random.shuffle(candidates)
    test_pool = candidates[:35]
    print(f"    Testing pool of {len(test_pool)} candidate proxies for speed and reachability...")

    live_proxies = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(check_proxy_health, p): p for p in test_pool}
        for future in concurrent.futures.as_completed(futures):
            res = future.result()
            if res:
                live_proxies.append(res)
                print(f"    ✓ Verified live proxy: {res}")
                if len(live_proxies) >= max_needed:
                    break

    print(f"    Selected {len(live_proxies)} active proxy/proxies for download.")
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
    cookies_dir = None
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

        # Check for cookies (stored in separate auth directory, never in workdir or bucket)
        raw_cookies = os.environ.get("YOUTUBE_COOKIES", "").strip()
        cookies_file = None
        if raw_cookies:
            cookies_dir = tempfile.mkdtemp(prefix="trove_auth_")
            cookies_file = os.path.join(cookies_dir, "cookies.txt")
            with open(cookies_file, "w", encoding="utf-8") as cf:
                cf.write(raw_cookies)
            cookie_lines = [l for l in raw_cookies.splitlines() if l.strip() and not l.startswith("#")]
            domains = set()
            for l in cookie_lines:
                parts = l.split()
                if parts:
                    domains.add(parts[0])
            print(f"    ✓ Loaded authenticated session from YOUTUBE_COOKIES secret:")
            print(f"      - File size: {len(raw_cookies)} bytes")
            print(f"      - Active cookie entries: {len(cookie_lines)}")
            print(f"      - Target domains: {', '.join(sorted(list(domains))[:4])}")
        elif os.path.exists("cookies.txt"):
            cookies_file = os.path.abspath("cookies.txt")
            print(f"    ✓ Loaded cookies from local cookies.txt file ({os.path.getsize(cookies_file)} bytes).")
        else:
            print("    ℹ No YOUTUBE_COOKIES secret or local cookies.txt found. Running unauthenticated.")

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
            "--sleep-requests", "1",
            "--sleep-interval", "2",
            "--max-sleep-interval", "5",
            "--print", "before_dl:[%(epoch>%Y-%m-%d %H:%M:%S)s] Downloading: %(title)s.%(ext)s",
            "--print", "after_move:[%(epoch>%Y-%m-%d %H:%M:%S)s] Success: %(title)s.%(ext)s"
        ]

        # Enable Node.js for solving YouTube JS challenge if available
        if shutil.which("node"):
            base_cmd.extend(["--js-runtimes", "node"])
            print("    ✓ Active JS Challenge Solver: Node.js")

        if cookies_file:
            print(f"    ✓ yt-dlp flag attached: --cookies {cookies_file}")
            base_cmd.extend(["--cookies", cookies_file])
        else:
            print("    ℹ Proceeding without --cookies flag.")

        if media_format == "mp4":
            base_cmd.extend(["-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4"])
        else:
            base_cmd.extend(["-f", "bestaudio", "-x", "--audio-format", "m4a"])

        # Fetch and verify live Proxifly proxies
        live_proxies = get_live_proxies(max_needed=5)
        download_success = False

        if live_proxies:
            for attempt_idx, proxy in enumerate(live_proxies, 1):
                print(f"\n--> [Proxy Download Attempt {attempt_idx}/{len(live_proxies)}] Testing with: {proxy}...")
                current_cmd = list(base_cmd)
                current_cmd.extend(["--proxy", proxy])
                current_cmd.extend(targets)

                proc = subprocess.run(current_cmd, text=True)
                if proc.returncode == 0:
                    print(f"    ✓ Download succeeded using proxy: {proxy}!")
                    download_success = True
                    break
                else:
                    print(f"    ✗ Proxy {proxy} exited with code {proc.returncode}. Trying next proxy...")

        if not download_success:
            print("\n--> Fallback: Attempting direct download (no proxy)...")
            current_cmd = list(base_cmd)
            current_cmd.extend(targets)
            proc = subprocess.run(current_cmd, text=True)
            if proc.returncode == 0:
                print("    ✓ Direct download succeeded!")
                download_success = True
            else:
                print(f"    Note: Direct download completed with exit code {proc.returncode}")

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
        if cookies_dir:
            shutil.rmtree(cookies_dir, ignore_errors=True)

if __name__ == "__main__":
    main()

