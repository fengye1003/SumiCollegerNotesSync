#!/usr/bin/env python
"""pdfcheck.py -- render page 1 of a PDF to PNG with PyMuPDF, print JSON stats.
Usage: python pdfcheck.py <in.pdf> <out.png> [--zoom N] [--threshold N] [--minarea N]
ASCII only.
"""
import sys, json

def main():
    args = sys.argv[1:]
    src, out = args[0], args[1]
    zoom = 1.0
    th = 60
    minarea = 6
    if '--zoom' in args:
        zoom = float(args[args.index('--zoom') + 1])
    if '--threshold' in args:
        th = int(args[args.index('--threshold') + 1])
    if '--minarea' in args:
        minarea = int(args[args.index('--minarea') + 1])

    import fitz
    doc = fitz.open(src)
    page = doc[0]
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    pix.save(out)

    # ink bbox via numpy-free scan
    w, h = pix.width, pix.height
    samples = pix.samples
    n = pix.n
    # background = modal color (coarse 16-level histogram)
    hist = {}
    for y in range(0, h, 1):
        base = y * pix.stride
        for x in range(0, w, 1):
            o = base + x * n
            key = (samples[o] >> 4, samples[o+1] >> 4, samples[o+2] >> 4)
            hist[key] = hist.get(key, 0) + 1
    bgk = max(hist, key=hist.get)
    # refine bg to mean of that bucket
    sr = sg = sb = c = 0
    for y in range(h):
        base = y * pix.stride
        for x in range(w):
            o = base + x * n
            if (samples[o] >> 4, samples[o+1] >> 4, samples[o+2] >> 4) == bgk:
                sr += samples[o]; sg += samples[o+1]; sb += samples[o+2]; c += 1
    bgr, bgg, bgb = (sr // c, sg // c, sb // c) if c else (255, 255, 255)

    x0, y0, x1, y1 = w, h, -1, -1
    ink = 0
    for y in range(h):
        base = y * pix.stride
        for x in range(w):
            o = base + x * n
            if abs(samples[o]-bgr) + abs(samples[o+1]-bgg) + abs(samples[o+2]-bgb) > th:
                ink += 1
                if x < x0: x0 = x
                if x > x1: x1 = x
                if y < y0: y0 = y
                if y > y1: y1 = y
    print(json.dumps({
        "pdf": src, "png": out, "pageW": round(page.rect.width, 2), "pageH": round(page.rect.height, 2),
        "w": w, "h": h, "bg": "#%02X%02X%02X" % (bgr, bgg, bgb), "ink": ink,
        "bbox": {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "w": x1-x0+1, "h": y1-y0+1} if x1 >= 0 else None,
        "pages": doc.page_count,
    }))

main()
