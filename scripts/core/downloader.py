"""
yt-dlp wrapper and media post-processor for Trove.
Handles quiet downloading, clean error extraction, thumbnail Golden-Ratio optimization,
and metadata provenance enrichment.
"""

import os
import json
import shutil
import subprocess
from pathlib import Path
from datetime import datetime, timezone
try:
    from core.logger import log_event, format_bytes, format_duration
except (ImportError, ModuleNotFoundError):
    try:
        from .logger import log_event, format_bytes, format_duration
    except (ImportError, ModuleNotFoundError):
        from scripts.core.logger import log_event, format_bytes, format_duration


class MediaDownloader:
    """Manages yt-dlp execution and media post-processing."""

    def __init__(
        self,
        workdir: str,
        metadata_dir: str,
        covers_dir: str,
        archive_file: str,
        media_format: str = "m4a",
        player_clients: str = "android,ios,mweb,tv,web",
        proxy: str = None
    ):
        self.workdir = workdir
        self.metadata_dir = metadata_dir
        self.covers_dir = covers_dir
        self.archive_file = archive_file
        self.media_format = media_format.lower()
        self.player_clients = player_clients
        self.proxy = proxy

        if self.media_format == "mp4":
            self.allowed_exts = {"mp4", "mkv", "webm", "avi", "mov", "flv", "wmv", "m4v", "ts"}
        else:
            self.allowed_exts = {"m4a", "mp3", "flac", "wav", "aac", "ogg", "opus", "wma", "alac", "aiff"}

    def build_base_cmd(self, proxy: str = None) -> list[str]:
        """Construct the core yt-dlp command line arguments."""
        out_template = os.path.join(self.workdir, "%(title)s.%(ext)s")
        meta_template = os.path.join(self.metadata_dir, "%(title)s.json")
        cover_template = os.path.join(self.covers_dir, "%(title)s.%(ext)s")

        cmd = [
            "yt-dlp",
            "--no-warnings",
            "--no-progress",
            "--force-ipv4",
            "--download-archive", self.archive_file,
            "--embed-thumbnail",
            "--write-thumbnail",
            "--convert-thumbnails", "jpg",
            "--add-metadata",
            "--print-to-file",
            "%(.{title,artist,creator,channel,uploader,album,album_artist,release_date,upload_date,duration,track,track_number,genre,description,thumbnail,id,webpage_url,tags,filesize})j",
            meta_template,
            "-o", out_template,
            "-o", f"thumbnail:{cover_template}",
            "--remote-components", "ejs:github",
            "--extractor-args", f"youtube:player_client={self.player_clients}",
        ]

        if self.media_format == "mp4":
            cmd.extend(["-f", "bestvideo+bestaudio/best", "--merge-output-format", "mp4"])
        else:
            cmd.extend(["-f", "ba[ext=m4a]/ba/b", "-x", "--audio-format", "m4a", "--audio-quality", "0"])

        ffmpeg_bin = shutil.which("ffmpeg")
        if ffmpeg_bin:
            cmd.extend(["--ffmpeg-location", os.path.dirname(ffmpeg_bin)])

        active_proxy = proxy or self.proxy
        if active_proxy:
            cmd.extend(["--proxy", active_proxy])

        return cmd

    def download(self, target: str, proxy: str = None, retries: int = 1, timeout: int = 15) -> tuple[bool, str, str]:
        """
        Execute yt-dlp quietly. Only emits structured errors or successes.
        Returns: (success: bool, status: str, error_msg: str)
        """
        cmd = self.build_base_cmd(proxy=proxy)
        cmd.extend([
            "--socket-timeout", str(timeout),
            "--retries", str(retries),
            "--extractor-retries", str(retries),
            target
        ])

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        stdout = proc.stdout or ""
        stderr = proc.stderr or ""

        if "has already been recorded in the archive" in stdout or "has already been recorded in the archive" in stderr:
            return True, "skipped_archive", ""

        if proc.returncode == 0:
            return True, "downloaded", ""

        err_lines = []
        for line in (stderr + "\n" + stdout).splitlines():
            line_clean = line.strip()
            if not line_clean:
                continue
            if line_clean.startswith("ERROR:"):
                err_lines.append(line_clean[6:].strip())
            elif any(phrase in line_clean for phrase in ["Sign in to confirm", "Private video", "Video unavailable", "HTTP Error", "IncompleteRead"]):
                err_lines.append(line_clean)

        err_msg = "; ".join(dict.fromkeys(err_lines)) if err_lines else (stderr.strip() or stdout.strip())[:250]
        return False, "failed", err_msg

    def get_pending_media(self, uploaded_paths: set) -> list[Path]:
        """Find media files in workdir that haven't been pushed to storage yet."""
        return [
            p for p in Path(self.workdir).iterdir()
            if p.is_file() and p.suffix.lstrip(".").lower() in self.allowed_exts and str(p) not in uploaded_paths
        ]

    def optimize_covers(self):
        """Downscale cover images to the Golden Ratio (max 600px, -q:v 3, ~35-50KB) using ffmpeg."""
        candidates = list(Path(self.workdir).glob("*.*")) + list(Path(self.covers_dir).glob("*.*"))
        for img in candidates:
            if img.is_file() and img.suffix.lstrip(".").lower() in ("jpg", "jpeg", "png", "webp"):
                dest = Path(self.covers_dir) / f"{img.stem}.jpg"
                tmp_opt = Path(self.covers_dir) / f"{img.stem}_tmp_opt.jpg"
                opt_res = subprocess.run([
                    "ffmpeg", "-v", "error", "-i", str(img),
                    "-vf", "scale='min(600,iw)':'min(600,ih)':force_original_aspect_ratio=decrease",
                    "-q:v", "3", str(tmp_opt), "-y"
                ], capture_output=True)
                if opt_res.returncode == 0 and tmp_opt.exists() and tmp_opt.stat().st_size > 400:
                    if img.exists() and img != dest:
                        try:
                            os.remove(img)
                        except Exception:
                            pass
                    shutil.move(str(tmp_opt), str(dest))
                elif img != dest:
                    try:
                        shutil.move(str(img), str(dest))
                    except Exception:
                        pass

    def enrich_metadata(self, mf: Path, bucket_id: str, now_epoch: int, now_iso: str) -> tuple[dict, dict]:
        """Write rich download provenance fields into metadata JSON and return manifest entry."""
        size_bytes = mf.stat().st_size
        file_format = mf.suffix.lstrip(".").lower()
        meta_file = Path(self.metadata_dir) / f"{mf.stem}.json"
        cover_file = Path(self.covers_dir) / f"{mf.stem}.jpg"

        data = {}
        if meta_file.exists():
            try:
                with open(meta_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
            except Exception as e:
                log_event("warn", "ingest:metadata", file=meta_file.name, error=str(e), message=f"Notice reading metadata {meta_file.name}")

        data["trove_ingested_at"] = now_epoch
        data["trove_ingested_at_iso"] = now_iso
        data["trove_media_file"] = mf.name
        data["trove_cover_file"] = cover_file.name if cover_file.exists() else ""
        data["trove_media_format"] = file_format
        data["trove_media_bytes"] = size_bytes
        data["trove_media_size"] = format_bytes(size_bytes)
        data["trove_duration_formatted"] = format_duration(data.get("duration"))
        data["trove_source"] = "youtube"
        data["trove_bucket"] = bucket_id
        data["trove_version"] = "1.0"

        try:
            with open(meta_file, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log_event("warn", "ingest:metadata", file=meta_file.name, error=str(e), message=f"Warning writing {meta_file.name}")

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
            "metadata_path": f"metadata/{meta_file.name}" if meta_file.exists() else "",
            "cover_path": f"covers/{cover_file.name}" if cover_file.exists() else "",
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
            "ingested_at": now_epoch,
            "ingested_at_iso": now_iso
        }

        return data, manifest_entry
