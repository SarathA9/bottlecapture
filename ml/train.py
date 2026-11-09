"""Train a water-mass regressor on the BottleCapture dataset.

Reads ONLY your own dataset folder (photos + their JSON labels from the app).
The professor's validation data is never read here. Use evaluate.py once, at the
very end, if you are allowed to score on it.

Honest testing: photos of the same fill share one water amount, so they always stay
together. Cross-validation holds out whole fills; the final check holds out whole
sessions marked "validation" in the app (if there are any).

Usage (Google Colab with a GPU is easiest):
    pip install -r requirements.txt
    python train.py --data "/content/BottleCapture Dataset" --out runs/b0
    python train.py --data ... --cv 5          # grouped 5-fold check first
"""
import argparse, glob, json, math, os, random
from collections import defaultdict

import numpy as np
import torch
import torch.nn as nn
from PIL import Image, ImageOps
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms

# ---------------------------------------------------------------- data


def load_items(root, exclude_fills=()):
    items = []
    for js in sorted(glob.glob(os.path.join(root, "**", "*.json"), recursive=True)):
        jpg = js[:-5] + ".jpg"
        if not os.path.exists(jpg):
            continue
        r = json.load(open(js, encoding="utf-8"))
        fill = r.get("fill_id") or f"{r['session_id']}_L{r.get('level_index')}"
        if fill in exclude_fills:
            continue
        items.append(
            dict(
                path=jpg,
                water=float(r["water_mass_g"]),
                fill=fill,
                session=r["session_id"],
                bottle=r["bottle_id"],
                split=r.get("split", "train"),
            )
        )
    return items


def pad_square(im, fill=(0, 0, 0)):
    """Keep the whole bottle: pad to a square instead of cropping."""
    w, h = im.size
    s = max(w, h)
    out = Image.new("RGB", (s, s), fill)
    out.paste(im, ((s - w) // 2, (s - h) // 2))
    return out


class Photos(Dataset):
    def __init__(self, items, size, train, scale):
        self.items, self.scale = items, scale
        norm = transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225])
        if train:
            self.tf = transforms.Compose(
                [
                    # Mild crops only: cutting off the bottle base or neck removes the evidence.
                    transforms.RandomResizedCrop(size, scale=(0.75, 1.0), ratio=(0.85, 1.15)),
                    transforms.RandomHorizontalFlip(),
                    transforms.RandomRotation(8),
                    transforms.ColorJitter(0.3, 0.3, 0.2, 0.03),
                    transforms.ToTensor(),
                    norm,
                ]
            )
        else:
            self.tf = transforms.Compose([transforms.Resize(size), transforms.ToTensor(), norm])

    def __len__(self):
        return len(self.items)

    def __getitem__(self, i):
        it = self.items[i]
        im = ImageOps.exif_transpose(Image.open(it["path"])).convert("RGB")
        im.thumbnail((1024, 1024))
        x = self.tf(pad_square(im))
        return x, torch.tensor(it["water"] / self.scale, dtype=torch.float32)


# ---------------------------------------------------------------- model


def build(arch, pretrained=True):
    if arch == "efficientnet_b0":
        m = models.efficientnet_b0(weights="IMAGENET1K_V1" if pretrained else None)
        n = m.classifier[1].in_features
        m.classifier = nn.Sequential(nn.Dropout(0.3), nn.Linear(n, 1))
        head = m.classifier
    elif arch == "convnext_tiny":
        m = models.convnext_tiny(weights="IMAGENET1K_V1" if pretrained else None)
        n = m.classifier[2].in_features
        m.classifier[2] = nn.Linear(n, 1)
        head = m.classifier
    else:
        raise ValueError(arch)
    return m, head


def run_epoch(model, loader, opt=None, device="cpu"):
    train = opt is not None
    model.train(train)
    losses, preds, ys = [], [], []
    for x, y in loader:
        x, y = x.to(device), y.to(device)
        with torch.set_grad_enabled(train):
            p = model(x).squeeze(1)
            loss = nn.functional.smooth_l1_loss(p, y)
            if train:
                opt.zero_grad()
                loss.backward()
                opt.step()
        losses.append(loss.item())
        preds.append(p.detach().cpu())
        ys.append(y.cpu())
    return float(np.mean(losses)), torch.cat(preds).numpy(), torch.cat(ys).numpy()


@torch.no_grad()
def predict(model, items, size, scale, device):
    """Average the photo and its mirror image (test-time augmentation)."""
    ds = Photos(items, size, False, scale)
    model.eval()
    out = []
    for x, _ in DataLoader(ds, batch_size=16):
        x = x.to(device)
        p = (model(x) + model(torch.flip(x, dims=[3]))) / 2
        out.append(p.squeeze(1).cpu())
    return np.clip(torch.cat(out).numpy() * scale, 0, None)


def train_model(train_items, args, device, val_items=None):
    model, head = build(args.arch, not args.no_pretrained)
    model.to(device)
    dl = DataLoader(
        Photos(train_items, args.size, True, args.scale),
        batch_size=args.batch,
        shuffle=True,
        num_workers=args.workers,
        drop_last=len(train_items) > args.batch,
    )
    # Stage 1: only the new head learns. Stage 2: everything, with a smaller learning rate.
    for p in model.parameters():
        p.requires_grad = False
    for p in head.parameters():
        p.requires_grad = True
    opt = torch.optim.AdamW(head.parameters(), lr=1e-3, weight_decay=1e-4)
    for e in range(args.warmup):
        loss, _, _ = run_epoch(model, dl, opt, device)
        print(f"  head epoch {e+1}/{args.warmup} loss {loss:.4f}")
    for p in model.parameters():
        p.requires_grad = True
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.epochs)
    for e in range(args.epochs):
        loss, _, _ = run_epoch(model, dl, opt, device)
        sched.step()
        msg = f"  epoch {e+1}/{args.epochs} loss {loss:.4f}"
        if val_items and (e + 1) % 5 == 0:
            p = predict(model, val_items, args.size, args.scale, device)
            msg += f" | val MAE {np.mean(np.abs(p - np.array([i['water'] for i in val_items]))):.1f} g"
        print(msg)
    return model


def report(items, pred, title):
    y = np.array([i["water"] for i in items])
    err = np.abs(pred - y)
    byfill = defaultdict(list)
    for i, p in zip(items, pred):
        byfill[i["fill"]].append(p)
    fill_err = [abs(np.mean(v) - next(i["water"] for i in items if i["fill"] == f)) for f, v in byfill.items()]
    base = np.mean(np.abs(y - y.mean()))
    print(f"\n{title}: {len(items)} photos, {len(byfill)} fills")
    print(f"  MAE per photo        {err.mean():7.1f} g")
    print(f"  MAE of fill average  {np.mean(fill_err):7.1f} g")
    print(f"  within 25 g          {np.mean(err <= 25) * 100:6.1f} %")
    print(f"  (always guessing the average here would score {base:.1f} g)")
    return dict(mae=float(err.mean()), fill_mae=float(np.mean(fill_err)), n=len(items))


# ---------------------------------------------------------------- linear probe


@torch.no_grad()
def embed(model, items, size, device):
    """Frozen pretrained features (photo and mirror image averaged)."""
    ds = Photos(items, size, False, 1.0)
    model.eval()
    out = []
    for x, _ in DataLoader(ds, batch_size=16):
        x = x.to(device)
        out.append(((model(x) + model(torch.flip(x, dims=[3]))) / 2).cpu())
    return torch.cat(out).numpy()


def linear_probe(items, folds, args, device):
    """Keep the network frozen; fit only a ridge regression on its features.
    Far fewer free settings than fine-tuning, so it memorises less on small data."""
    from sklearn.linear_model import RidgeCV
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    model, _ = build(args.arch, not args.no_pretrained)
    if args.arch == "efficientnet_b0":
        model.classifier = nn.Identity()
    else:
        model.classifier[2] = nn.Identity()
    model.to(device)
    X = embed(model, items, args.size, device)
    y = np.array([i["water"] for i in items])
    preds = np.zeros(len(items))
    for held in folds:
        te = np.array([i["fill"] in held for i in items])
        reg = make_pipeline(StandardScaler(), RidgeCV(alphas=np.logspace(-1, 5, 25)))
        reg.fit(X[~te], y[~te])
        preds[te] = np.clip(reg.predict(X[te]), 0, None)
    return preds


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="Your BottleCapture Dataset folder")
    ap.add_argument("--out", default="runs/model")
    ap.add_argument("--arch", default="efficientnet_b0", choices=["efficientnet_b0", "convnext_tiny"])
    ap.add_argument("--size", type=int, default=384)
    ap.add_argument("--epochs", type=int, default=25)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--scale", type=float, default=100.0, help="grams per output unit")
    ap.add_argument("--cv", type=int, default=0, help="grouped k-fold over fills (0 = off)")
    ap.add_argument("--exclude-fill", action="append", default=[], help="fill_id to leave out (bad label)")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--no-pretrained", action="store_true", help="only for offline smoke tests")
    ap.add_argument("--probe", action="store_true", help="with --cv: frozen network + ridge regression")
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    items = load_items(args.data, set(args.exclude_fill))
    fills = sorted({i["fill"] for i in items})
    print(f"{len(items)} photos, {len(fills)} fills, {len({i['bottle'] for i in items})} bottles, device {device}")
    os.makedirs(args.out, exist_ok=True)

    if args.cv:
        rng = random.Random(args.seed)
        order = fills[:]
        rng.shuffle(order)
        folds = [order[k :: args.cv] for k in range(args.cv)]
        if args.probe:
            preds = linear_probe(items, folds, args, device)
            res = report(items, preds, f"Linear probe, grouped {args.cv}-fold (whole fills held out)")
            json.dump(res, open(os.path.join(args.out, "probe_cv.json"), "w"), indent=1)
            return
        preds = np.zeros(len(items))
        for k, held in enumerate(folds):
            print(f"\nFold {k+1}/{args.cv}: holding out fills {held}")
            tr = [i for i in items if i["fill"] not in held]
            te_idx = [n for n, i in enumerate(items) if i["fill"] in held]
            model = train_model(tr, args, device)
            preds[te_idx] = predict(model, [items[n] for n in te_idx], args.size, args.scale, device)
        res = report(items, preds, f"Grouped {args.cv}-fold cross-validation (whole fills held out)")
        json.dump(res, open(os.path.join(args.out, "cv.json"), "w"), indent=1)
        return

    val = [i for i in items if i["split"] in ("validation", "holdout")]
    train = [i for i in items if i["split"] not in ("validation", "holdout")]
    if not val:
        print("No validation sessions yet: training on everything, no honest score. Run with --cv first.")
    model = train_model(train, args, device, val or None)
    torch.save({"state": model.state_dict(), "arch": args.arch, "size": args.size, "scale": args.scale}, os.path.join(args.out, "model.pt"))
    if val:
        report(val, predict(model, val, args.size, args.scale, device), "Validation sessions")
    print(f"\nSaved {os.path.join(args.out, 'model.pt')}")


if __name__ == "__main__":
    main()
