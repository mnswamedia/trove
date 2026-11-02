#!/usr/bin/env python3
"""
Trove Cover Art Optimizer & Generator.
Downloads existing high-resolution / large covers from your Hugging Face Storage Bucket,
compresses and resizes them to the Golden Ratio (max 600px, quality 80, ~35-50 KB),
and uploads them back. Also extracts and optimizes covers for any songs missing one.

Usage:
    python3 scripts/generate_covers.py --token "hf_yourTokenHere"
    # or with environment variable:
    export HF_TOKEN="hf_yourTokenHere"
    python3 scripts/generate_covers.py
"""

import os
import sys
import json
import shutil
import getpass
import argparse
import tempfile
import subprocess
import urllib.request
import urllib.parse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

DEFAULT_REPO = "mnswa/trove_dataset"
AUDIO_EXTENSIONS = {
    "m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "wma", "alac", "aiff"
}
IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp"}

def check_ffmpeg() -> bool:
    """Verify ffmpeg binary exists on the system."""
    return shutil.which("ffmpeg") is not None

def format_bytes_py(b):
    """Format byte count into human-readable string (KB/MB)."""
    if b < 1024:
        return f"{b} B"
    elif b < 1024 * 1024:
        return f"{round(b / 1024, 1)} KB"
    else:
        return f"{round(b / (1024 * 1024), 2)} MB"

def get_download_urls(bucket_id: str, remote_path: str):
    """Generate candidate URLs to download a file from Hugging Face."""
    encoded_path = "/".join(urllib.parse.quote(seg) for seg in remote_path.split("/"))
    return [
        f"https://huggingface.co/buckets/{bucket_id}/resolve/{encoded_path}",
        f"https://huggingface.co/buckets/{bucket_id}/raw/{encoded_path}",
        f"https://huggingface.co/api/buckets/{bucket_id}/raw/{encoded_path}",
        f"https://huggingface.co/datasets/{bucket_id}/resolve/main/{encoded_path}",
        f"https://huggingface.co/datasets/{bucket_id}/raw/main/{encoded_path}",
    ]

def download_file(bucket_id: str, remote_path: str, local_path: str, token: str) -> bool:
    """Download a file from Hugging Face via direct HTTP GET, falling back to CLI."""
    urls = get_download_urls(bucket_id, remote_path)
    for url in urls:
        try:
            headers = {"Authorization": f"Bearer {token}"} if token else {}
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status == 200:
                    with open(local_path, "wb") as f:
                        shutil.copyfileobj(resp, f)
                    if os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                        return True
        except Exception:
            pass

    # CLI fallback: hf buckets cp
    try:
        env = {**os.environ, "HF_TOKEN": token}
        res = subprocess.run(
            ["hf", "buckets", "cp", f"hf://buckets/{bucket_id}/{remote_path}", local_path],
            env=env,
            capture_output=True,
            text=True,
            timeout=60
        )
        if res.returncode == 0 and os.path.exists(local_path) and os.path.getsize(local_path) > 0:
            return True
    except Exception:
        pass

    return False

def upload_file_to_hf(local_path: str, remote_path: str, bucket_id: str, token: str) -> tuple:
    """Upload a file to Hugging Face bucket using CLI or HfApi, returning (success, error_log)."""
    env = {**os.environ, "HF_TOKEN": token}
    errors = []

    # 1. High-speed official CLI: hf buckets cp
    try:
        res = subprocess.run(
            ["hf", "buckets", "cp", local_path, f"hf://buckets/{bucket_id}/{remote_path}"],
            env=env,
            capture_output=True,
            text=True,
            timeout=45
        )
        if res.returncode == 0:
            return True, ""
        err_msg = (res.stderr or res.stdout or "").strip()
        errors.append(f"hf buckets cp exit {res.returncode}: {err_msg[:160]}")
    except FileNotFoundError:
        errors.append("hf CLI not found on PATH (run: pip install -U \"huggingface_hub[cli]\")")
    except Exception as e:
        errors.append(f"hf buckets cp exception: {e}")

    # 2. HfApi upload
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
        api.upload_file(
            path_or_fileobj=local_path,
            path_in_repo=remote_path,
            repo_id=bucket_id,
            repo_type="dataset"
        )
        return True, ""
    except ModuleNotFoundError:
        errors.append("huggingface_hub python package not installed (run: pip install -U \"huggingface_hub[cli]\")")
    except Exception as e:
        errors.append(f"HfApi error: {e}")

    # 3. Direct HTTP REST API upload
    try:
        encoded_remote = "/".join(urllib.parse.quote(seg) for seg in remote_path.split("/"))
        upload_urls = [
            f"https://huggingface.co/api/buckets/{bucket_id}/raw/{encoded_remote}",
            f"https://huggingface.co/api/datasets/{bucket_id}/upload/main/{encoded_remote}"
        ]
        with open(local_path, "rb") as f:
            file_bytes = f.read()

        for url in upload_urls:
            try:
                req = urllib.request.Request(
                    url,
                    data=file_bytes,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "image/jpeg"
                    },
                    method="PUT"
                )
                with urllib.request.urlopen(req, timeout=30) as resp:
                    if resp.status in (200, 201, 204):
                        return True, ""
            except urllib.error.HTTPError as he:
                errors.append(f"HTTP PUT ({url.split('/api/')[1]}): {he.code} {he.reason}")
            except Exception as e:
                errors.append(f"HTTP error: {e}")
    except Exception as e:
        errors.append(f"HTTP prep error: {e}")

    return False, " | ".join(errors)

def optimize_image(input_img_path: str, output_img_path: str, max_dim: int = 600, quality: int = 3) -> bool:
    """
    Compress and downscale an existing image to the Golden Ratio (max 600px, quality 80).
    Never upscales smaller images.
    """
    scale_filter = f"scale='min({max_dim},iw)':'min({max_dim},ih)':force_original_aspect_ratio=decrease"
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", input_img_path,
        "-vf", scale_filter,
        "-q:v", str(quality),
        output_img_path,
        "-y"
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if res.returncode == 0 and os.path.exists(output_img_path) and os.path.getsize(output_img_path) > 400:
            return True
    except Exception:
        pass
    return False

def extract_and_optimize_from_audio(media_path: str, cover_path: str, max_dim: int = 600, quality: int = 3) -> bool:
    """
    Extract embedded album artwork from an audio container and convert directly
    to the Golden Ratio JPEG.
    """
    scale_filter = f"scale='min({max_dim},iw)':'min({max_dim},ih)':force_original_aspect_ratio=decrease"
    cmd = [
        "ffmpeg", "-v", "error",
        "-i", media_path,
        "-an",
        "-vf", scale_filter,
        "-q:v", str(quality),
        cover_path,
        "-y"
    ]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
        if res.returncode == 0 and os.path.exists(cover_path) and os.path.getsize(cover_path) > 400:
            return True
    except Exception:
        pass
    return False

def list_bucket_files(bucket_id: str, token: str) -> list:
    """Retrieve full file list from Hugging Face bucket."""
    # 1. HfApi
    try:
        from huggingface_hub import HfApi
        api = HfApi(token=token)
        files = api.list_repo_files(repo_id=bucket_id, repo_type="dataset")
        if files:
            return files
    except Exception as e:
        print(f"  Notice: HfApi listing: {e}")

    # 2. Bucket Tree API
    try:
        tree_url = f"https://huggingface.co/api/buckets/{bucket_id}/tree?recursive=true"
        req = urllib.request.Request(tree_url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.load(resp)
            files = []
            for item in data:
                p = item.get("path") or item.get("rfilename")
                if p:
                    files.append(p)
            if files:
                return files
    except Exception as e:
        print(f"  Notice: Bucket tree listing: {e}")

    # 3. CLI: hf buckets ls
    try:
        env = {**os.environ, "HF_TOKEN": token}
        res = subprocess.run(
            ["hf", "buckets", "ls", f"hf://buckets/{bucket_id}"],
            env=env,
            capture_output=True,
            text=True,
            timeout=25
        )
        if res.returncode == 0:
            lines = res.stdout.strip().splitlines()
            files = [line.strip().split()[-1] for line in lines if line.strip()]
            if files:
                return files
    except Exception:
        pass

    return []

def process_existing_cover(remote_cover_path: str, bucket_id: str, token: str, temp_base_dir: str, max_dim: int, quality: int, force: bool) -> tuple:
    """
    Task to optimize an existing large cover:
    1. Downloads remote cover to local temp
    2. Compresses with FFmpeg to Golden Ratio
    3. Uploads optimized image back to covers/
    """
    task_dir = tempfile.mkdtemp(dir=temp_base_dir, prefix="opt_")
    stem = Path(remote_cover_path).stem
    local_raw = os.path.join(task_dir, f"raw_{os.path.basename(remote_cover_path)}")
    local_opt = os.path.join(task_dir, f"{stem}.jpg")
    dest_remote = f"covers/{stem}.jpg"

    try:
        ok = download_file(bucket_id, remote_cover_path, local_raw, token)
        if not ok or not os.path.exists(local_raw):
            return (remote_cover_path, False, "Download failed", 0, 0)

        raw_bytes = os.path.getsize(local_raw)

        # Skip if already small and not forced
        if not force and raw_bytes <= 65 * 1024:
            return (remote_cover_path, True, f"Already optimized ({format_bytes_py(raw_bytes)})", raw_bytes, raw_bytes)

        # Compress to Golden Ratio
        compressed = optimize_image(local_raw, local_opt, max_dim=max_dim, quality=quality)
        if not compressed or not os.path.exists(local_opt):
            return (remote_cover_path, False, "FFmpeg optimization failed", raw_bytes, raw_bytes)

        opt_bytes = os.path.getsize(local_opt)
        reduction_pct = round(((raw_bytes - opt_bytes) / raw_bytes) * 100, 1)

        # Upload optimized file
        uploaded, upload_err = upload_file_to_hf(local_opt, dest_remote, bucket_id, token)
        if not uploaded:
            return (remote_cover_path, False, f"Upload error: {upload_err}", raw_bytes, opt_bytes)

        msg = f"{format_bytes_py(raw_bytes)} -> {format_bytes_py(opt_bytes)} (-{reduction_pct}%)"
        return (remote_cover_path, True, msg, raw_bytes, opt_bytes)
    finally:
        shutil.rmtree(task_dir, ignore_errors=True)

def process_missing_song(song_path: str, bucket_id: str, token: str, temp_base_dir: str, max_dim: int, quality: int) -> tuple:
    """
    Task to extract artwork from an audio file that has no cover yet:
    1. Downloads audio file
    2. Runs FFmpeg directly to extract & scale to Golden Ratio
    3. Uploads to covers/
    """
    stem = Path(song_path).stem
    dest_remote = f"covers/{stem}.jpg"
    task_dir = tempfile.mkdtemp(dir=temp_base_dir, prefix="song_")
    local_song = os.path.join(task_dir, os.path.basename(song_path))
    local_opt = os.path.join(task_dir, f"{stem}.jpg")

    try:
        ok = download_file(bucket_id, song_path, local_song, token)
        if not ok or not os.path.exists(local_song):
            return (song_path, False, "Download failed", 0, 0)

        extracted = extract_and_optimize_from_audio(local_song, local_opt, max_dim=max_dim, quality=quality)
        if not extracted or not os.path.exists(local_opt):
            return (song_path, False, "No embedded artwork found", 0, 0)

        opt_bytes = os.path.getsize(local_opt)
        uploaded, upload_err = upload_file_to_hf(local_opt, dest_remote, bucket_id, token)
        if not uploaded:
            return (song_path, False, f"Upload error: {upload_err}", 0, opt_bytes)

        return (song_path, True, f"Extracted ({format_bytes_py(opt_bytes)})", 0, opt_bytes)
    finally:
        shutil.rmtree(task_dir, ignore_errors=True)

def main():
    parser = argparse.ArgumentParser(
        description="Optimize existing covers and generate Golden Ratio artwork (~35-50KB) in Hugging Face bucket."
    )
    parser.add_argument("--repo", default=DEFAULT_REPO, help=f"Hugging Face repository ID (default: {DEFAULT_REPO})")
    parser.add_argument("--token", default=os.getenv("HF_TOKEN"), help="Hugging Face User Access Token (or set HF_TOKEN env)")
    parser.add_argument("--workers", type=int, default=4, help="Number of concurrent worker threads (default: 4)")
    parser.add_argument("--max-dim", type=int, default=600, help="Maximum width/height dimension (default: 600px)")
    parser.add_argument("--quality", type=int, default=3, help="FFmpeg JPEG quality scale 1-31 (default: 3 = visually lossless)")
    parser.add_argument("--force", action="store_true", help="Re-compress even if already under 65 KB")
    parser.add_argument("--dry-run", action="store_true", help="List targets without downloading or uploading")
    args = parser.parse_args()

    print("==================================================")
    print(" Trove - Golden Ratio Cover Art Optimizer")
    print(f" Repository:  {args.repo}")
    print(f" Target Spec: Max {args.max_dim}px | Quality -q:v {args.quality} (Target: ~35-50 KB)")
    print(f" Workers:     {args.workers}")
    print("==================================================")

    # 1. Validate FFmpeg
    if not check_ffmpeg():
        print("\n❌ Error: FFmpeg was not found on your system PATH.")
        print("   Please install FFmpeg or ensure it is accessible in your terminal.")
        sys.exit(1)
    print("✓ FFmpeg binary detected.")

    # 2. Check for huggingface_hub / hf CLI
    has_hf_cli = shutil.which("hf") is not None
    try:
        import huggingface_hub
        has_hf_hub = True
    except ImportError:
        has_hf_hub = False

    if has_hf_cli:
        print("✓ Official 'hf' CLI detected.")
    elif has_hf_hub:
        print("✓ Python 'huggingface_hub' library detected.")
    else:
        print("\n⚠️  NOTICE: Neither 'hf' CLI nor 'huggingface_hub' Python library was found.")
        print("   Hugging Face Storage Buckets require the huggingface_hub toolchain to upload.")
        print("   👉 Run this in your terminal: pip install -U \"huggingface_hub[cli]\"")
        print("   (Attempting direct HTTP fallback in the meantime...)\n")

    # 3. Validate Token
    token = args.token
    if not token:
        try:
            token = getpass.getpass("Enter your Hugging Face Access Token: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nAborted.")
            sys.exit(1)

    if not token:
        print("❌ Error: A valid Hugging Face token is required.")
        sys.exit(1)

    # 4. Discover Files in Bucket
    print(f"\n--> Fetching file inventory from {args.repo}...")
    files = list_bucket_files(args.repo, token)
    if not files:
        print(f"❌ Error: Could not list files in {args.repo}. Verify your token and permissions.")
        sys.exit(1)

    print(f"    Total files in bucket: {len(files)}")

    # Existing covers in bucket
    existing_covers = [
        f for f in files
        if f.startswith("covers/") and f.split(".")[-1].lower() in IMAGE_EXTENSIONS
    ]

    # Audio files
    audio_files = [
        f for f in files
        if "." in f and f.split(".")[-1].lower() in AUDIO_EXTENSIONS
        and not f.startswith("metadata/")
        and not f.startswith("covers/")
    ]

    existing_cover_stems = {Path(f).stem for f in existing_covers}
    missing_audio = [f for f in audio_files if Path(f).stem not in existing_cover_stems]

    print(f"    Existing covers in 'covers/': {len(existing_covers)}")
    print(f"    Total audio tracks in bucket: {len(audio_files)}")
    print(f"    Audio tracks missing covers:  {len(missing_audio)}")

    if not existing_covers and not missing_audio:
        print("\n✨ No covers to optimize and no songs missing covers! Nothing to do.")
        sys.exit(0)

    if args.dry_run:
        print("\n[DRY RUN SUMMARY]")
        print(f"  Covers to optimize: {len(existing_covers)}")
        print(f"  Songs to extract:   {len(missing_audio)}")
        sys.exit(0)

    temp_dir = tempfile.mkdtemp(prefix="trove_opt_batch_")
    total_saved_bytes = 0
    total_optimized = 0
    total_extracted = 0
    total_failed = 0

    try:
        # ==============================================================
        # STEP A: Optimize Existing Large Covers
        # ==============================================================
        if existing_covers:
            print(f"\n==================================================")
            print(f" Step 1: Compressing {len(existing_covers)} Existing Covers to Golden Ratio")
            print(f"==================================================")

            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                future_to_cover = {
                    executor.submit(process_existing_cover, c, args.repo, token, temp_dir, args.max_dim, args.quality, args.force): c
                    for c in existing_covers
                }

                for idx, future in enumerate(as_completed(future_to_cover), 1):
                    remote_path, success, msg, raw_b, opt_b = future.result()
                    name = Path(remote_path).name
                    pct = round((idx / len(existing_covers)) * 100, 1)

                    if success:
                        if raw_b > opt_b:
                            saved = raw_b - opt_b
                            total_saved_bytes += saved
                            total_optimized += 1
                            print(f"[{idx}/{len(existing_covers)}] ({pct}%) ✓ Optimized: {name} ({msg})")
                        else:
                            print(f"[{idx}/{len(existing_covers)}] ({pct}%) ↷ Kept: {name} ({msg})")
                    else:
                        total_failed += 1
                        print(f"[{idx}/{len(existing_covers)}] ({pct}%) ✗ Failed: {name}")
                        print(f"      Reason: {msg}\n")

        # ==============================================================
        # STEP B: Extract & Optimize Any Missing Songs
        # ==============================================================
        if missing_audio:
            print(f"\n==================================================")
            print(f" Step 2: Extracting Artwork for {len(missing_audio)} Missing Songs")
            print(f"==================================================")

            with ThreadPoolExecutor(max_workers=args.workers) as executor:
                future_to_song = {
                    executor.submit(process_missing_song, s, args.repo, token, temp_dir, args.max_dim, args.quality): s
                    for s in missing_audio
                }

                for idx, future in enumerate(as_completed(future_to_song), 1):
                    remote_path, success, msg, _, opt_b = future.result()
                    name = Path(remote_path).name
                    pct = round((idx / len(missing_audio)) * 100, 1)

                    if success:
                        total_extracted += 1
                        print(f"[{idx}/{len(missing_audio)}] ({pct}%) ✓ Extracted & Uploaded: {name} ({msg})")
                    else:
                        if "No embedded artwork" in msg:
                            print(f"[{idx}/{len(missing_audio)}] ({pct}%) ⚠ No embedded art: {name}")
                        else:
                            total_failed += 1
                            print(f"[{idx}/{len(missing_audio)}] ({pct}%) ✗ Failed: {name}")
                            print(f"      Reason: {msg}\n")

        # ==============================================================
        # STEP C: Update downloads.json manifest
        # ==============================================================
        print("\n--> Verifying downloads.json manifest...")
        downloads_local = os.path.join(temp_dir, "downloads.json")
        has_downloads = download_file(args.repo, "downloads.json", downloads_local, token)
        if has_downloads and os.path.exists(downloads_local):
            try:
                with open(downloads_local, "r", encoding="utf-8") as f:
                    manifest_data = json.load(f)
                if isinstance(manifest_data, list):
                    updated_manifest = False
                    for entry in manifest_data:
                        if isinstance(entry, dict):
                            fname = entry.get("filename") or entry.get("path") or ""
                            stem = Path(fname).stem
                            expected_cover = f"covers/{stem}.jpg"
                            if entry.get("cover_path") != expected_cover:
                                entry["cover_path"] = expected_cover
                                updated_manifest = True

                    if updated_manifest:
                        with open(downloads_local, "w", encoding="utf-8") as f:
                            json.dump(manifest_data, f, indent=2, ensure_ascii=False)
                        upload_file_to_hf(downloads_local, "downloads.json", args.repo, token)
                        print("✓ downloads.json manifest updated with cover paths.")
                    else:
                        print("✓ downloads.json manifest already up to date.")
            except Exception as e:
                print(f"Notice updating downloads.json: {e}")

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    print("\n==================================================")
    print(" Optimization Complete!")
    print(f" Covers Optimized:   {total_optimized}")
    print(f" Missing Extracted:  {total_extracted}")
    print(f" Failed:             {total_failed}")
    if total_saved_bytes > 0:
        print(f" Total Bandwidth Saved: {format_bytes_py(total_saved_bytes)} 🎉")
    print("==================================================")

if __name__ == "__main__":
    main()
