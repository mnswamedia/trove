#!/usr/bin/env python3
"""
Trove Media Ingest Script for GitHub Actions / Local Execution.
Orchestrates downloading media from YouTube with yt-dlp, metadata & thumbnail extraction,
and high-speed pushing to Hugging Face Storage Bucket.

All logs strictly adhere to the machine-readable format:
[YYYY-MM-DD] [HH:MM:SS] [LOG_LEVEL] [service:component] {"json": "payload"}
"""

import os
import sys
import time
import json
import shutil
import tempfile
import concurrent.futures
from pathlib import Path
from datetime import datetime, timezone

# Ensure the scripts directory is in sys.path so core modules import cleanly
sys.path.insert(0, str(Path(__file__).resolve().parent))

from core.logger import (
    log_event,
    send_progress_ping,
    send_telemetry_event,
    format_bytes,
    parse_targets,
    JOB_ID,
    GITHUB_RUN_ID
)
from core.warp import WarpTunnel, get_live_proxies
from core.storage import StorageClient
from core.downloader import MediaDownloader

# ==============================================================================
# Configuration Toggles
# ==============================================================================
YOUTUBE_PLAYER_CLIENTS = os.getenv("YOUTUBE_PLAYER_CLIENTS", "android,ios,mweb,tv,web")
ENABLE_PROXY_FALLBACK = os.getenv("ENABLE_PROXY_FALLBACK", "false").lower() in ("true", "1", "yes")
MAX_PROXY_ATTEMPTS = int(os.getenv("MAX_PROXY_ATTEMPTS", "5"))
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "3"))


def main():
    bucket_id = os.environ.get("BUCKET_ID", "mnswa/trove_dataset").strip()
    token = os.environ.get("HF_TOKEN") or os.environ.get("INPUT_HF_TOKEN") or ""
    token = token.strip()

    if not token:
        log_event("error", "ingest:init", error="missing_hf_token", message="No Hugging Face token found. Set HF_TOKEN env variable or secret.")
        sys.exit(1)

    storage = StorageClient(bucket_id=bucket_id, token=token)

    # 1. Backfill Mode
    is_backfill = "--backfill" in sys.argv or os.environ.get("BACKFILL", "").lower() in ("true", "1", "yes")
    if is_backfill:
        storage.backfill_manifest()
        return

    # 2. Parse Ingestion Targets
    raw_targets = os.environ.get("TARGETS", "").strip()
    media_format = os.environ.get("MEDIA_FORMAT", "m4a").strip().lower()

    if not raw_targets:
        log_event("error", "ingest:init", error="missing_targets", message="No targets provided. Set TARGETS env variable.")
        sys.exit(1)

    targets = parse_targets(raw_targets)
    if not targets:
        log_event("error", "ingest:init", error="invalid_targets", message="No valid YouTube URLs or IDs found.")
        sys.exit(1)

    log_event(
        "info",
        "ingest:init",
        targets_count=len(targets),
        format=media_format,
        bucket_id=bucket_id,
        job_id=JOB_ID,
        run_id=GITHUB_RUN_ID,
        message=f"Trove Media Ingestion started ({len(targets)} targets, format: {media_format.upper()})"
    )

    # Working Directories
    workdir = tempfile.mkdtemp(prefix="trove_ingest_")
    metadata_dir = os.path.join(workdir, "metadata")
    covers_dir = os.path.join(workdir, "covers")
    os.makedirs(metadata_dir, exist_ok=True)
    os.makedirs(covers_dir, exist_ok=True)
    archive_file = os.path.join(workdir, "all_songs.txt")

    start_epoch = int(time.time())
    start_time_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    start_time_slug = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    target_results = []

    send_telemetry_event("run_started", run_id=JOB_ID, total_tracks=len(targets), format=media_format, bucket_id=bucket_id)
    send_progress_ping("started", title=f"Ingestion started for {len(targets)} item(s)")

    try:
        # 3. Synchronize Ledger (all_songs.txt) from Storage Bucket
        storage.sync_ledger(archive_file)

        # 4. Activate Cloudflare WARP SOCKS5 Tunnel
        warp_tunnel = WarpTunnel()
        with warp_tunnel as warp_proxy:
            downloader = MediaDownloader(
                workdir=workdir,
                metadata_dir=metadata_dir,
                covers_dir=covers_dir,
                archive_file=archive_file,
                media_format=media_format,
                player_clients=YOUTUBE_PLAYER_CLIENTS,
                proxy=warp_proxy
            )

            if warp_proxy:
                log_event("info", "ingest:network", warp_active=True, proxy=warp_proxy, message="Cloudflare WARP SOCKS5 tunnel active")
            else:
                log_event("info", "ingest:network", warp_active=False, proxy="direct", message="Direct connection (Cloudflare WARP not active)")

            # 5. Fetch Existing Root Manifest (downloads.json)
            existing_downloads, downloads_file = storage.fetch_existing_downloads(workdir)
            log_event("info", "ingest:manifest", entries_count=len(existing_downloads), message=f"Existing manifest contains {len(existing_downloads)} recorded downloads")
            entries_by_filename = {e.get("filename"): e for e in existing_downloads if isinstance(e, dict) and e.get("filename")}
            entries_by_id = {e.get("id"): e for e in existing_downloads if isinstance(e, dict) and e.get("id")}

            uploaded_media_paths = set()
            uploaded_meta_paths = set()
            uploaded_cover_paths = set()
            total_uploaded = 0
            chunk_number = 0
            live_proxies = None
            successful_targets = 0
            total_targets = len(targets)
            max_warp_regens = 3
            warp_regens_count = 0

            def flush_chunk(reason="chunk"):
                nonlocal total_uploaded, chunk_number
                pending = downloader.get_pending_media(uploaded_media_paths)
                if not pending:
                    return 0

                chunk_number += 1
                log_event(
                    "info",
                    "ingest:chunk",
                    chunk_number=chunk_number,
                    pending_count=len(pending),
                    reason=reason,
                    message=f"Pushing chunk #{chunk_number} with {len(pending)} song(s) to Hugging Face ({reason})"
                )

                now_epoch = int(time.time())
                now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

                # Optimize cover art
                downloader.optimize_covers()

                files_to_push = []
                for mf in pending:
                    mdata, manifest_entry = downloader.enrich_metadata(mf, bucket_id, now_epoch, now_iso)
                    vid = manifest_entry.get("id")

                    if mf.name in entries_by_filename:
                        entries_by_filename[mf.name].update(manifest_entry)
                    elif vid and vid in entries_by_id:
                        entries_by_id[vid].update(manifest_entry)
                    else:
                        existing_downloads.append(manifest_entry)
                        entries_by_filename[mf.name] = manifest_entry
                        if vid:
                            entries_by_id[vid] = manifest_entry

                    files_to_push.append((str(mf), mf.name, "media"))

                    meta_file = Path(metadata_dir) / f"{mf.stem}.json"
                    if meta_file.exists() and str(meta_file) not in uploaded_meta_paths:
                        files_to_push.append((str(meta_file), f"metadata/{meta_file.name}", "meta"))

                    cover_file = Path(covers_dir) / f"{mf.stem}.jpg"
                    if cover_file.exists() and str(cover_file) not in uploaded_cover_paths:
                        files_to_push.append((str(cover_file), f"covers/{cover_file.name}", "cover"))

                # Write updated downloads.json
                existing_downloads.sort(key=lambda x: x.get("ingested_at") or 0, reverse=True)
                with open(downloads_file, "w", encoding="utf-8") as f:
                    json.dump(existing_downloads, f, indent=2, ensure_ascii=False)

                files_to_push.append((downloads_file, "downloads.json", "manifest"))
                if os.path.exists(archive_file):
                    files_to_push.append((archive_file, "all_songs.txt", "ledger"))

                chunk_uploaded = 0

                def _push_worker(item):
                    l_path, r_path, ftype = item
                    ok = storage.upload_file(l_path, r_path)
                    return item, ok

                max_workers = min(6, len(files_to_push))
                with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as executor:
                    for (l_path, r_path, ftype), ok in executor.map(_push_worker, files_to_push):
                        if ok:
                            if ftype == "media":
                                uploaded_media_paths.add(l_path)
                                chunk_uploaded += 1
                                try:
                                    os.remove(l_path)
                                except Exception:
                                    pass
                            elif ftype == "meta":
                                uploaded_meta_paths.add(l_path)
                            elif ftype == "cover":
                                uploaded_cover_paths.add(l_path)
                                try:
                                    os.remove(l_path)
                                except Exception:
                                    pass

                total_uploaded += chunk_uploaded
                log_event(
                    "success",
                    "ingest:chunk",
                    chunk_number=chunk_number,
                    uploaded_media_count=chunk_uploaded,
                    total_library_entries=len(existing_downloads),
                    message=f"Chunk #{chunk_number} complete: {chunk_uploaded} media file(s) uploaded (total entries: {len(existing_downloads)})"
                )
                return chunk_uploaded

            # 6. Process Targets Sequentially
            for target_idx, target in enumerate(targets, 1):
                if target_idx > 1:
                    log_event("info", "ingest:flow", target_index=target_idx, total_targets=total_targets, pause_seconds=10, message=f"Pausing 10s before target {target_idx}/{total_targets}")
                    time.sleep(10)

                log_event("info", "ingest:download", target_index=target_idx, total_targets=total_targets, target=target, message=f"Ingesting target [{target_idx}/{total_targets}]: {target}")
                send_telemetry_event("item_started", run_id=JOB_ID, track_index=target_idx, url=target)

                target_success = False

                # Attempt 1: Direct Download (or through WARP)
                log_event("info", "ingest:download", attempt=1, method="direct", target=target, message="Starting direct download")
                ok, dl_status, err_msg = downloader.download(target)

                if ok:
                    if dl_status == "skipped_archive":
                        log_event("info", "ingest:download", attempt=1, target=target, status="skipped", reason="already_in_archive", message=f"{target} has already been recorded in the archive")
                    else:
                        target_success = True
                else:
                    log_event("warn", "ingest:download", attempt=1, method="direct", target=target, error=err_msg, message=f"Direct download failed: {err_msg}")

                    # Check for YouTube bot block / Sign-in required error
                    is_sign_in_err = any(phrase in (err_msg or "").lower() for phrase in [
                        "sign in to confirm", "sign in to continue", "confirm you're not a bot", "not a bot", "bot confirmation"
                    ])

                    if is_sign_in_err:
                        if warp_regens_count < max_warp_regens and warp_tunnel:
                            warp_regens_count += 1
                            log_event(
                                "warn", "ingest:warp_renew",
                                regen=warp_regens_count,
                                max_regens=max_warp_regens,
                                target=target,
                                error=err_msg,
                                message=f"Sign-in bot block encountered. Renewing WARP config ({warp_regens_count}/{max_warp_regens}) and retrying..."
                            )
                            new_proxy = warp_tunnel.renew()
                            if new_proxy:
                                downloader.proxy = new_proxy
                                ok_w, dl_status_w, err_msg_w = downloader.download(target)
                                if ok_w:
                                    if dl_status_w == "skipped_archive":
                                        log_event("info", "ingest:download", attempt=1, target=target, status="skipped", reason="already_in_archive", message=f"{target} has already been recorded in the archive")
                                    else:
                                        target_success = True
                                        log_event("success", "ingest:download", method="warp_renewed", target=target, message="Download succeeded after WARP renewal!")
                                else:
                                    err_msg = err_msg_w
                                    is_still_sign_in = any(phrase in (err_msg_w or "").lower() for phrase in [
                                        "sign in to confirm", "sign in to continue", "confirm you're not a bot", "not a bot"
                                    ])
                                    if is_still_sign_in:
                                        log_event("error", "ingest:fatal_bot_block", target=target, error=err_msg_w, message=f"Target still failed with sign-in error after WARP renewal ({warp_regens_count}/{max_warp_regens}). Aborting ingestion run.")
                                        send_progress_ping("failed", title=f"Bot block persists after WARP renewal: {err_msg_w}")
                                        send_telemetry_event("run_failed", run_id=JOB_ID, error=err_msg_w)
                                        sys.exit(1)
                        else:
                            log_event("error", "ingest:fatal_bot_block", target=target, error=err_msg, message=f"Sign-in bot block encountered and max WARP renewals ({max_warp_regens}) exhausted. Aborting ingestion run.")
                            send_progress_ping("failed", title=f"Bot block encountered ({err_msg})")
                            send_telemetry_event("run_failed", run_id=JOB_ID, error=err_msg)
                            sys.exit(1)

                    # Attempt 2: Optional Rotating Proxies Fallback (only if not a fatal bot block)
                    if not target_success and ENABLE_PROXY_FALLBACK:
                        log_event("info", "ingest:proxy", message="Switching to rotating verified proxies from Proxifly")
                        if live_proxies is None:
                            live_proxies = get_live_proxies(max_needed=MAX_PROXY_ATTEMPTS)

                        if live_proxies:
                            for attempt_idx, proxy in enumerate(live_proxies, 1):
                                log_event("info", "ingest:proxy", attempt=attempt_idx, proxy=proxy, target=target, message=f"Testing download with proxy {proxy}")
                                ok_p, dl_status_p, err_msg_p = downloader.download(target, proxy=proxy, retries=2, timeout=15)
                                if ok_p:
                                    target_success = True
                                    log_event("success", "ingest:download", attempt=attempt_idx, method="proxy", proxy=proxy, target=target, message=f"Download succeeded using proxy {proxy}")
                                    break
                                else:
                                    log_event("warn", "ingest:proxy", attempt=attempt_idx, proxy=proxy, target=target, error=err_msg_p, message=f"Proxy attempt failed: {err_msg_p}")
                    elif not target_success and not is_sign_in_err:
                        log_event("info", "ingest:proxy", message="Proxy fallback is disabled (ENABLE_PROXY_FALLBACK=False). Skipping proxies.")

                    if not target_success and dl_status != "skipped_archive":
                        log_event("error", "ingest:download", target=target, error=err_msg, message=f"All download attempts failed for {target}")

                if target_success:
                    successful_targets += 1
                    song_title = ""
                    song_id = ""
                    file_format = media_format
                    size_bytes = 0
                    pending_now = downloader.get_pending_media(uploaded_media_paths)
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

                    log_event(
                        "success",
                        "ingest:download",
                        target=target,
                        song_id=song_id,
                        title=song_title or target,
                        format=file_format,
                        size_bytes=size_bytes,
                        size_formatted=format_bytes(size_bytes),
                        message=f"Download succeeded: {song_title or target}"
                    )

                    target_results.append({
                        "id": song_id,
                        "url": target,
                        "title": song_title or target,
                        "format": file_format,
                        "size_bytes": size_bytes,
                        "size_formatted": format_bytes(size_bytes),
                        "status": "success"
                    })

                    send_telemetry_event(
                        "item_ended",
                        run_id=JOB_ID,
                        track_index=target_idx,
                        url=target,
                        song_id=song_id,
                        title=song_title or target,
                        status="succeeded",
                        size_bytes=size_bytes,
                        format=file_format
                    )

                    if len(pending_now) >= CHUNK_SIZE:
                        flush_chunk(reason=f"Reached threshold of {CHUNK_SIZE} songs")
                elif dl_status == "skipped_archive":
                    target_results.append({
                        "id": "",
                        "url": target,
                        "title": target,
                        "status": "skipped",
                        "message": "already_in_archive"
                    })
                    send_telemetry_event(
                        "item_ended",
                        run_id=JOB_ID,
                        track_index=target_idx,
                        url=target,
                        status="skipped_archive",
                        title=target
                    )
                else:
                    err_msg = err_msg or "Download failed (sign in or unavailable)"
                    target_results.append({
                        "id": "",
                        "url": target,
                        "title": target,
                        "status": "failed",
                        "error": err_msg
                    })
                    send_telemetry_event(
                        "item_ended",
                        run_id=JOB_ID,
                        track_index=target_idx,
                        url=target,
                        status="failed",
                        error=err_msg
                    )

            # 7. Final Chunk Flush
            pending_remaining = downloader.get_pending_media(uploaded_media_paths)
            if pending_remaining:
                flush_chunk(reason="Final remaining songs in batch")

            # 8. Upload Permanent Ingestion Report
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
                log_event("info", "ingest:report", remote_path=remote_report_path, message=f"Uploading permanent ingestion report to {remote_report_path}")
                storage.upload_file(report_local, remote_report_path)
                log_event("success", "ingest:report", remote_path=remote_report_path, message="Ingestion report uploaded successfully")
            except Exception as report_err:
                log_event("warn", "ingest:report", error=str(report_err), message="Could not upload ingestion report")

            send_telemetry_event(
                "run_ended",
                run_id=JOB_ID,
                status="completed",
                succeeded_tracks=successful_targets,
                failed_tracks=total_targets - successful_targets
            )
            send_progress_ping("completed", title=f"Finished: {successful_targets}/{total_targets} succeeded")

            if total_uploaded == 0 and successful_targets == 0:
                log_event("info", "ingest:summary", targets_total=total_targets, successful=0, message="No new media files were downloaded (items may already exist in all_songs.txt)")
                return

            log_event(
                "info",
                "ingest:summary",
                targets_processed=total_targets,
                successful_downloads=successful_targets,
                media_uploaded=total_uploaded,
                duration_seconds=duration_sec,
                bucket_id=bucket_id,
                message=f"Ingestion complete: {successful_targets}/{total_targets} succeeded, {total_uploaded} uploaded in {duration_sec}s"
            )

    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
