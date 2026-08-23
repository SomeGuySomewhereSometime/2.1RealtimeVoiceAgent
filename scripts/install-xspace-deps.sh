#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 -m venv "$project_dir/.venv-xspace"
"$project_dir/.venv-xspace/bin/python" -m pip install -r "$project_dir/xspace/requirements.txt"
