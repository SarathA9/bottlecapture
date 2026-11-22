"""Shrink every photo once, before training.

Phone photos are 12 MP. Opening and shrinking all of them again in every epoch
makes training spend most of its time reading files. This makes an upright
copy of each photo, at most `longest` pixels on its long side, once. Later runs
reuse the copies. A photo that changed (other size or date) gets a new copy.
The originals are never modified.
"""
import hashlib
import os
from concurrent.futures import ProcessPoolExecutor

from PIL import Image, ImageOps


def _key(path, longest):
    st = os.stat(path)
    raw = f"{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}|{longest}"
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


def _shrink(job):
    src, dst, longest = job
    if os.path.exists(dst):
        return dst
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    im.thumbnail((longest, longest), Image.LANCZOS)
    tmp = dst + ".part"
    im.save(tmp, "JPEG", quality=95)
    os.replace(tmp, dst)  # never leave a half-written copy behind
    return dst


def cache_photos(items, cache_dir, longest=1024, workers=4):
    """Point each item's "path" at its shrunk copy. Returns how many were new."""
    os.makedirs(cache_dir, exist_ok=True)
    jobs = []
    for it in items:
        dst = os.path.join(cache_dir, _key(it["path"], longest) + ".jpg")
        jobs.append((it["path"], dst, longest))
    new = sum(1 for _, dst, _ in jobs if not os.path.exists(dst))
    if new:
        print(f"Shrinking {new} photos once (cache: {cache_dir})…", flush=True)
    with ProcessPoolExecutor(max_workers=max(1, workers)) as ex:
        for it, dst in zip(items, ex.map(_shrink, jobs, chunksize=8)):
            it["original"] = it["path"]
            it["path"] = dst
    return new
