"""
Hugging Face Storage Bucket client for Trove.
Handles bidirectional syncing of media files, metadata JSONs, covers,
the downloads.json manifest, and the all_songs.txt download archive ledger.
"""

import os
import json
import time
import shutil
import tempfile
import subprocess
import urllib.request
from pathlib import Path
from datetime import datetime, timezone
try:
    from core.logger import log_event, format_bytes, format_duration
except (ImportError, ModuleNotFoundError):
    try:
        from .logger import log_event, format_bytes, format_duration
    except (ImportError, ModuleNotFoundError):
        from scripts.core.logger import log_event, format_bytes, format_duration


class StorageClient:
    """Client for high-speed Hugging Face Storage Bucket operations."""

    def __init__(self, bucket_id: str, token: str):
        self.bucket_id = bucket_id.strip()
        self.token = token.strip()
        self.env = {**os.environ, "HF_TOKEN": self.token}

    def upload_file(self, local_path: str, remote_path: str) -> bool:
        """Upload a single file to Hugging Face Storage Bucket using hf buckets cp with HfApi fallback."""
        # 1. High-Speed S3/Xet CLI: hf buckets cp
        try:
            cp_res = subprocess.run(
                ["hf", "buckets", "cp", local_path, f"hf://buckets/{self.bucket_id}/{remote_path}"],
                env=self.env,
                capture_output=True,
                text=True
            )
            if cp_res.returncode == 0:
                log_event("success", "ingest:upload", file=remote_path, method="hf_buckets_cp", message=f"Uploaded {remote_path} via hf buckets cp")
                return True
            else:
                err_msg = cp_res.stderr.strip() or cp_res.stdout.strip()
                log_event("warn", "ingest:upload", file=remote_path, method="hf_buckets_cp", notice=err_msg[:120])
        except Exception as e:
            log_event("warn", "ingest:upload", file=remote_path, method="hf_buckets_cp", error=str(e))

        # 2. Fallback: HfApi upload_file
        try:
            from huggingface_hub import HfApi
            api = HfApi(token=self.token)
            api.upload_file(
                path_or_fileobj=local_path,
                path_in_repo=remote_path,
                repo_id=self.bucket_id,
                repo_type="dataset"
            )
            log_event("success", "ingest:upload", file=remote_path, method="hf_api", message=f"Uploaded {remote_path} via HfApi upload")
            return True
        except Exception as api_err:
            log_event("error", "ingest:upload", file=remote_path, error=str(api_err), message=f"Failed to upload {remote_path}")
            return False

    def fetch_file(self, remote_path: str, local_path: str) -> bool:
        """Fast-fetch a remote file from Hugging Face bucket via direct HTTP GET, falling back to CLI."""
        urls = [
            f"https://huggingface.co/api/buckets/{self.bucket_id}/raw/{remote_path}",
            f"https://huggingface.co/buckets/{self.bucket_id}/resolve/{remote_path}",
            f"https://huggingface.co/datasets/{self.bucket_id}/raw/main/{remote_path}",
            f"https://huggingface.co/datasets/{self.bucket_id}/resolve/main/{remote_path}"
        ]
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"Authorization": f"Bearer {self.token}"})
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

        try:
            res = subprocess.run(
                ["hf", "buckets", "cp", f"hf://buckets/{self.bucket_id}/{remote_path}", local_path],
                env=self.env,
                capture_output=True,
                text=True,
                timeout=10
            )
            if res.returncode == 0 and os.path.exists(local_path) and os.path.getsize(local_path) > 0:
                return True
        except Exception:
            pass

        return False

    def fetch_existing_downloads(self, workdir: str) -> tuple[list, str]:
        """Fetch and parse existing downloads.json manifest from HF Storage Bucket."""
        downloads_file = os.path.join(workdir, "downloads.json")
        loaded = self.fetch_file("downloads.json", downloads_file)

        if loaded and os.path.exists(downloads_file):
            try:
                with open(downloads_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        return data, downloads_file
                    elif isinstance(data, dict) and "downloads" in data and isinstance(data["downloads"], list):
                        return data["downloads"], downloads_file
            except Exception as e:
                log_event("warn", "ingest:manifest", error=str(e), message="Could not parse existing downloads.json; starting fresh")

        return [], downloads_file

    def sync_ledger(self, archive_file: str) -> tuple[bool, int]:
        """Sync download archive ledger (all_songs.txt) from bucket."""
        log_event("info", "ingest:ledger", bucket_id=self.bucket_id, message="Syncing all_songs.txt ledger from bucket")
        loaded = self.fetch_file("all_songs.txt", archive_file)
        if loaded:
            log_event("info", "ingest:ledger", status="loaded", message="Loaded existing all_songs.txt from bucket")
        else:
            Path(archive_file).touch()
            log_event("info", "ingest:ledger", status="created_empty", message="No existing ledger found; created empty all_songs.txt")

        count = 0
        if os.path.exists(archive_file):
            with open(archive_file, "r", encoding="utf-8") as f:
                count = sum(1 for line in f if line.strip())
        log_event("info", "ingest:ledger", entries_count=count, message=f"Ledger currently contains {count} song entries")
        return loaded, count

    def backfill_manifest(self):
        """Scan existing files and metadata in the bucket to construct or backfill downloads.json."""
        log_event("info", "ingest:backfill", bucket_id=self.bucket_id, message="Starting Trove Manifest Backfill")

        workdir = tempfile.mkdtemp(prefix="trove_backfill_")
        downloads_file = os.path.join(workdir, "downloads.json")

        try:
            file_list = []
            try:
                from huggingface_hub import HfApi
                api = HfApi(token=self.token)
                file_list = api.list_repo_files(repo_id=self.bucket_id, repo_type="dataset")
            except Exception as e:
                log_event("warn", "ingest:backfill", method="hf_api", error=str(e), message="HfApi list_repo_files notice")

            if not file_list:
                try:
                    tree_url = f"https://huggingface.co/api/buckets/{self.bucket_id}/tree?recursive=true"
                    req = urllib.request.Request(tree_url, headers={"Authorization": f"Bearer {self.token}"})
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        tree_data = json.load(resp)
                        for item in tree_data:
                            p = item.get("path") or item.get("rfilename")
                            if p:
                                file_list.append(p)
                except Exception as e:
                    log_event("warn", "ingest:backfill", method="tree_api", error=str(e), message="Bucket tree fallback notice")

            if not file_list:
                log_event("error", "ingest:backfill", error="empty_file_list", message="Could not retrieve file list from bucket")
                return

            log_event("info", "ingest:backfill", total_discovered=len(file_list), message=f"Discovered {len(file_list)} total entries in bucket")

            audio_video_exts = {"m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "mp4", "mkv", "webm"}
            media_paths = [
                f for f in file_list 
                if "." in f and f.split(".")[-1].lower() in audio_video_exts and not f.startswith("metadata/")
            ]
            metadata_paths = {
                Path(f).stem: f for f in file_list 
                if f.startswith("metadata/") and f.endswith(".json")
            }

            log_event("info", "ingest:backfill", media_count=len(media_paths), metadata_count=len(metadata_paths), message=f"Found {len(media_paths)} media files and {len(metadata_paths)} metadata records")

            existing_downloads, _ = self.fetch_existing_downloads(workdir)
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
                    meta_url = f"https://huggingface.co/api/buckets/{self.bucket_id}/raw/{meta_path}"
                    try:
                        req = urllib.request.Request(meta_url, headers={"Authorization": f"Bearer {self.token}"})
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
                    "duration": format_duration(duration_sec),
                    "duration_seconds": duration_sec,
                    "size_bytes": size_bytes,
                    "size_formatted": format_bytes(size_bytes),
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

            log_event("info", "ingest:backfill", total_entries=len(existing_downloads), scanned_count=backfilled_count, message=f"Built downloads.json with {len(existing_downloads)} entries")

            uploaded = self.upload_file(downloads_file, "downloads.json")
            log_event("success" if uploaded else "error", "ingest:backfill", success=uploaded, message="Manifest backfill complete")
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
