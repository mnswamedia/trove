FROM mwader/static-ffmpeg:6.1 AS ffmpeg-source

FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# Copy static ffmpeg and ffprobe binaries (avoids pulling 100+ Debian shared library packages)
COPY --from=ffmpeg-source /ffmpeg /ffprobe /usr/local/bin/

# Minimal system deps: git (for actions/checkout), curl, ca-certificates, unzip
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates git unzip \
 && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# Deno (JS runtime used by yt-dlp for YouTube challenge solving)
RUN curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/deno \
 && rm /tmp/deno.zip \
 && deno --version

# wireproxy: single static binary that turns a WireGuard (WARP) config into a SOCKS5 proxy
RUN curl -fsSL https://github.com/pufferffish/wireproxy/releases/latest/download/wireproxy_linux_amd64.tar.gz \
    | tar -xz -C /usr/local/bin wireproxy \
 && chmod +x /usr/local/bin/wireproxy

# Python deps: yt-dlp[default] pulls in yt-dlp-ejs (the EJS solver)
RUN pip install --no-cache-dir -U "yt-dlp[default]" huggingface_hub requests PySocks mutagen \
 && find /usr/local/lib/python3.11 -name '__pycache__' -exec rm -rf {} + 2>/dev/null || true \
 && yt-dlp --version && ffmpeg -version && hf --help >/dev/null

COPY docker/run-with-warp.sh /usr/local/bin/run-with-warp
RUN chmod +x /usr/local/bin/run-with-warp

WORKDIR /work
