#!/usr/bin/env python3
"""Draw the Tracky icon set (rounded square + magnifier) as PNGs.

Run:  python3 scripts/make_icons.py
Writes extension/icons/icon{16,32,48,128}.png from a 512px master.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parents[1] / "extension" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

S = 512
BG = (14, 21, 35, 255)
AMBER = (240, 180, 41, 255)
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"


def master() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.22), fill=BG)

    cx, cy, rad = S * 0.44, S * 0.42, S * 0.235
    stroke = int(S * 0.075)
    d.ellipse((cx - rad, cy - rad, cx + rad, cy + rad), outline=AMBER, width=stroke)

    hx0, hy0 = cx + rad * 0.62, cy + rad * 0.62
    hx1, hy1 = S * 0.83, S * 0.83
    d.line((hx0, hy0, hx1, hy1), fill=AMBER, width=int(stroke * 1.2))
    d.ellipse((hx1 - stroke * 0.6, hy1 - stroke * 0.6, hx1 + stroke * 0.6, hy1 + stroke * 0.6), fill=AMBER)

    try:
        font = ImageFont.truetype(FONT_PATH, int(S * 0.30))
        t = "T"
        bb = d.textbbox((0, 0), t, font=font)
        d.text(
            (cx - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1] - S * 0.012),
            t,
            font=font,
            fill=AMBER,
        )
    except OSError:
        pass  # font missing: the lens + handle still read fine
    return img


def main() -> None:
    resample = getattr(Image, "Resampling", Image).LANCZOS
    m = master()
    for size in (16, 32, 48, 128):
        m.resize((size, size), resample).save(OUT / f"icon{size}.png")
    print("wrote " + ", ".join(str(OUT / f"icon{s}.png") for s in (16, 32, 48, 128)))


if __name__ == "__main__":
    main()
