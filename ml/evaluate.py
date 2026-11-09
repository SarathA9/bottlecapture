"""Predict water mass for a folder of photos, and score it if labels are given.

Use this on the professor's validation data only ONCE, at the very end, and only if
you are allowed to. Never change the model because of that score: then it stops being
a fair test.

    python evaluate.py --model runs/b0/model.pt --images "/path/to/photos" --out predictions.csv
    python evaluate.py ... --labels labels.csv    # optional: columns filename,water_g
"""
import argparse, csv, glob, os

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
        truth = {r["filename"]: float(r["water_g"]) for r in csv.DictReader(open(a.labels))}
        err = [abs(g - truth[n]) for n, g in rows if n in truth]
        print(f"Scored {len(err)} photos: MAE {np.mean(err):.1f} g, within 25 g {np.mean(np.array(err) <= 25) * 100:.1f} %")


if __name__ == "__main__":
    main()
