#!/usr/bin/env bash
# Set up and train the water-mass model on an OTH GPU workstation (ki-029 … ki-032).
# Usage:  bash run_on_workstation.sh "$HOME/BottleCapture Dataset"
# It runs in the background, so you can log out. Follow it with:
#   tail -f ~/bottle_runs/train.log
set -euo pipefail

DATA="${1:-$HOME/BottleCapture Dataset}"
HERE="$(cd "$(dirname "$0")" && pwd)"
RUNS="$HOME/bottle_runs"
mkdir -p "$RUNS"

if [ ! -d "$DATA" ]; then
  echo "Dataset folder not found: $DATA"
  echo "Copy it first (see ml/README.md, 'GPU workstation')."
  exit 1
fi
echo "Photos found: $(find "$DATA" -name '*.jpg' | wc -l), labels: $(find "$DATA" -name '*.json' | wc -l)"
if [ "$(find "$DATA" -name '*.json' | wc -l)" -eq 0 ]; then
  echo "No .json label files found. Copy the whole folder, including the .json files."
  exit 1
fi

echo "GPU:"
nvidia-smi --query-gpu=name,memory.used,memory.total --format=csv,noheader || echo "  nvidia-smi not available"

# Own Python environment, so nothing system-wide changes.
if [ ! -d "$HOME/bottle_venv" ]; then
  python3 -m venv "$HOME/bottle_venv"
fi
source "$HOME/bottle_venv/bin/activate"
pip install -q --upgrade pip
pip install -q -r "$HERE/requirements.txt"
python - <<'EOF'
import torch
print("torch", torch.__version__, "| CUDA available:", torch.cuda.is_available())
EOF

cd "$HERE"
nohup bash -c "
  echo '=== Grouped 5-fold cross-validation (whole fills held out) ===';
  python train.py --data \"$DATA\" --cv 5 --out \"$RUNS/cv\" --workers 4;
  echo; echo '=== Final model on all training sessions ===';
  python train.py --data \"$DATA\" --out \"$RUNS/final\" --workers 4;
  echo; echo 'DONE. Model: $RUNS/final/model.pt'
" > "$RUNS/train.log" 2>&1 &
echo
echo "Training started in the background (process $!)."
echo "Watch it with:   tail -f $RUNS/train.log"
echo "You can close the SSH window; it keeps running."
