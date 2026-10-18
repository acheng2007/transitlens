#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
python -m pip install --disable-pip-version-check -r bus-service/requirements.txt -r voice-service/requirements.txt
npm --prefix web ci --include=dev
npm --prefix web run build
