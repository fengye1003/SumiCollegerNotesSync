#!/usr/bin/env python
"""img2raw.py -- decode an image (jpg/png/...) to raw RGBA8, plus a .json sidecar.
Usage: python img2raw.py <src> <out.raw>
Writes <out.raw> (RGBA8, row-major) and <out.raw>.json = {"w":..,"h":..}
ASCII only.
"""
import sys, json, os

def main():
    src, out = sys.argv[1], sys.argv[2]
    from PIL import Image
    im = Image.open(src)
    im = im.convert("RGBA")
    w, h = im.size
    with open(out, "wb") as f:
        f.write(im.tobytes())
    with open(out + ".json", "w", encoding="utf-8") as f:
        json.dump({"w": w, "h": h, "src": src}, f)
    print(json.dumps({"w": w, "h": h, "out": out}))

main()
