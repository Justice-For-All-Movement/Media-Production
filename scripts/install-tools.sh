#!/usr/bin/env bash
# System packages the media production engine drives (Debian/Ubuntu names). Run as root.
# Every tool is probed at runtime; a missing one yields an explicit `unavailable` error naming it.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=600 update
apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends \
  ffmpeg \
  librsvg2-bin imagemagick libimage-exiftool-perl \
  pandoc libreoffice-writer poppler-utils \
  fluidsynth fluid-soundfont-gm espeak-ng sox \
  fonts-dejavu-core fonts-dejavu-extra fonts-noto-core fontconfig \
  zip unzip \
  tesseract-ocr python3-numpy   # the last two are used by the test suite only
