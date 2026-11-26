"""Predict water mass for a folder of photos, and score it if labels are given.

Use this on the professor's validation data only ONCE, at the very end, and only if
you are allowed to. Never change the model because of that score: then it stops being
a fair test. Every scored run is added to ml/VALIDATION_LOG.md, so it stays visible
how often a labelled set was looked at.

    python evaluate.py --model runs/b0/model.pt --images "/path/to/photos" --out predictions.csv
    python evaluate.py ... --labels labels.txt    # "327.jpg 585" per line, or CSV filename,water_g
"""
import argparse, csv, datetime, glob, os

import numpy as np
import torch
from PIL import Image, ImageOps
from torchvision import transforms

from train import build, pad_square


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--images", required=True)
    ap.add_argument("--out", default="predictions.csv")
    ap.add_argument("--labels", help="optional CSV with columns filename,water_g")
    a = ap.parse_args()
    ck = torch.load(a.model, map_location="cpu", weights_only=True)
    model, _ = build(ck["arch"], pretrained=False)
    model.load_state_dict(ck["state"])
    model.eval()
    tf = transforms.Compose(
        [
            transforms.Resize(ck["size"]),
            transforms.ToTensor(),
            transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
        ]
    )
    paths = sorted(
        p for p in glob.glob(os.path.join(a.images, "**", "*"), recursive=True)
        if p.lower().endswith((".jpg", ".jpeg", ".png"))
    )
    rows = []
    with torch.no_grad():
        for p in paths:
            im = ImageOps.exif_transpose(Image.open(p)).convert("RGB")
            im.thumbnail((1024, 1024))
            x = tf(pad_square(im))[None]
            g = float(((model(x) + model(torch.flip(x, dims=[3]))) / 2).item() * ck["scale"])
            rows.append((os.path.basename(p), round(max(g, 0.0), 1)))
    with open(a.out, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["filename", "predicted_water_g"])
        w.writerows(rows)
    print(f"Wrote {len(rows)} predictions to {a.out}")
    if a.labels:
        truth = read_labels(a.labels)
        pairs = [(n, g, truth[n]) for n, g in rows if n in truth]
        missing = [n for n, _ in rows if n not in truth]
        if not pairs:
            raise SystemExit("No photo names matched the labels file.")
        y = np.array([t for _, _, t in pairs])
        err = np.abs(np.array([g for _, g, _ in pairs]) - y)
        guess = float(np.mean(np.abs(y - y.mean())))
        print(f"\nScored {len(pairs)} photos" + (f" ({len(missing)} without a label)" if missing else ""))
        print(f"  MAE per photo        {err.mean():7.1f} g")
        print(f"  median error         {np.median(err):7.1f} g")
        print(f"  within 25 g          {np.mean(err <= 25) * 100:6.1f} %")
        print(f"  within 50 g          {np.mean(err <= 50) * 100:6.1f} %")
        print(f"  (always guessing the average of these photos would score {guess:.1f} g)")
        print("\n  photo        true   predicted   error")
        for n, g, t in sorted(pairs, key=lambda r: r[2]):
            print(f"  {n:<12}{t:6.0f} g {g:8.0f} g {abs(g - t):7.0f} g")
        log = os.path.join(os.path.dirname(os.path.abspath(__file__)), "VALIDATION_LOG.md")
        new = not os.path.exists(log)
        with open(log, "a") as f:
            if new:
                f.write("# Looks at labelled evaluation sets\n\nOne line per scored run. Never train or tune on these photos.\n\n")
            f.write(f"- {datetime.datetime.now():%Y-%m-%d %H:%M} · {a.images} · model {a.model} · {len(pairs)} photos · MAE {err.mean():.1f} g · within 25 g {np.mean(err <= 25) * 100:.0f} % · guessing {guess:.1f} g\n")
        print(f"\nLogged in {log}")


def read_labels(path):
    """filename -> grams, from "name grams" lines or a CSV with filename,water_g."""
    text = open(path, encoding="utf-8").read()
    first = text.lstrip().splitlines()[0] if text.strip() else ""
    if "," in first and "filename" in first:
        return {r["filename"]: float(r["water_g"]) for r in csv.DictReader(text.splitlines())}
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if len(parts) >= 2:
            out[os.path.basename(parts[0])] = float(parts[-1])
    return out


if __name__ == "__main__":
    main()
