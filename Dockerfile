FROM python:3.11-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1

# System deps: ffmpeg for yt-dlp, git so actions/checkout uses real git
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates git unzip \
 && rm -rf /var/lib/apt/lists/*

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

# Python deps. yt-dlp[default] pulls in yt-dlp-ejs (the EJS solver) so no runtime download is needed.
RUN pip install -U "yt-dlp[default]" huggingface_hub requests PySocks mutagen \
 && yt-dlp --version && hf --help >/dev/null

COPY docker/run-with-warp.sh /usr/local/bin/run-with-warp
RUN chmod +x /usr/local/bin/run-with-warp

WORKDIR /work

