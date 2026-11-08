"""Draws every LemonLime logo file from code, so the mark stays exact at every size.

    python3 brand/build.py           # writes the SVGs in brand/
    node brand/render.mjs            # turns them into PNG, ICO and ICNS files

Needs fontTools and uharfbuzz (`pip3 install --user fonttools uharfbuzz brotli`) and the
fonts the apps already install (`pnpm install`). The text in the wordmark and preview
images is turned into outlines, so the files look the same without the fonts.
"""

from __future__ import annotations

import glob
import io
import math
import os

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Brand colours (see brand/README.md).
CREAM = "#FFFBEA"
CREAM_2 = "#FFF6CF"
INK = "#17200E"
INK_2 = "#4B5637"
RIND = "#11190A"
RIND_2 = "#1B2610"
LEMON = "#FFE135"
LIME = "#A3E635"
LEMON_PEEL = "#FFD60A"
LIME_PEEL = "#7CC81E"


# ── Fonts ────────────────────────────────────────────────────────────────────


def _font_file(package: str, name: str) -> str:
    hits = glob.glob(os.path.join(ROOT, "node_modules/.pnpm", f"@fontsource-variable+{package}@*", "node_modules/@fontsource-variable", package, "files", name))
    if not hits:
        raise SystemExit(f"Couldn't find {name}. Run pnpm install first.")
    return sorted(hits)[-1]


class Face:
    """One weight of a variable font, ready to shape and outline."""

    def __init__(self, path: str, axes: dict[str, float]):
        font = TTFont(path)
        instantiateVariableFont(font, axes, inplace=True)
        font.flavor = None
        buf = io.BytesIO()
        font.save(buf)
        self.font = TTFont(io.BytesIO(buf.getvalue()))
        self.hb = hb.Font(hb.Face(buf.getvalue()))
        self.upem = self.font["head"].unitsPerEm
        self.glyphs = self.font.getGlyphSet()
        self.order = self.font.getGlyphOrder()

    def path(self, text: str, size: float, x: float = 0, y: float = 0, tracking: float = 0) -> tuple[str, float]:
        """SVG path data for `text` with its baseline at (x, y), and the advance width."""
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        hb.shape(self.hb, buf, {"kern": True, "liga": True})
        scale = size / self.upem
        pen = SVGPathPen(self.glyphs)
        pos = 0.0
        for info, p in zip(buf.glyph_infos, buf.glyph_positions):
            name = self.order[info.codepoint]
            gx = x + (pos + p.x_offset) * scale
            gy = y - p.y_offset * scale
            self.glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, gx, gy)))
            pos += p.x_advance + tracking * self.upem
        width = (pos - tracking * self.upem) * scale
        return pen.getCommands(), width


DISPLAY = Face(_font_file("bricolage-grotesque", "bricolage-grotesque-latin-standard-normal.woff2"), {"opsz": 96, "wght": 800, "wdth": 100})
BODY = Face(_font_file("inter", "inter-latin-wght-normal.woff2"), {"wght": 500})
BODY_BOLD = Face(_font_file("inter", "inter-latin-wght-normal.woff2"), {"wght": 650})

WORD = "lemonlime"
HEADLINE = ["Cloud agents that", "keep working after", "you close your laptop."]
WORD_TRACKING = -0.03  # em


# ── The mark: one slice, half lemon and half lime ─────────────────────────────


def _wedge(cx: float, cy: float, a0: float, a1: float, ro: float, d: float) -> str:
    """One segment: the wedge between angles a0 and a1, pulled in by d from both cut edges."""

    def edge(a: float, side: int, r: float) -> tuple[float, float]:
        ux, uy = math.cos(a), math.sin(a)
        nx, ny = math.cos(a + side * math.pi / 2), math.sin(a + side * math.pi / 2)
        t = math.sqrt(max(r * r - d * d, 0))
        return cx + d * nx + t * ux, cy + d * ny + t * uy

    mid = (a0 + a1) / 2
    tip = d / math.sin((a1 - a0) / 2)
    tx, ty = cx + tip * math.cos(mid), cy + tip * math.sin(mid)
    p0, p1 = edge(a0, 1, ro), edge(a1, -1, ro)
    return f"M{tx:.2f} {ty:.2f}L{p0[0]:.2f} {p0[1]:.2f}A{ro:g} {ro:g} 0 0 1 {p1[0]:.2f} {p1[1]:.2f}Z"


def _ring(cx: float, cy: float, r_out: float, r_in: float, left: bool | None) -> str:
    """A ring (left=None) or its left or right half, as one path."""
    if left is None:
        return (
            f"M{cx - r_out:g} {cy:g}A{r_out:g} {r_out:g} 0 1 1 {cx + r_out:g} {cy:g}A{r_out:g} {r_out:g} 0 1 1 {cx - r_out:g} {cy:g}Z"
            f"M{cx - r_in:g} {cy:g}A{r_in:g} {r_in:g} 0 1 0 {cx + r_in:g} {cy:g}A{r_in:g} {r_in:g} 0 1 0 {cx - r_in:g} {cy:g}Z"
        )
    s = 1 if left else -1
    return f"M{cx:g} {cy + s * r_out:g}A{r_out:g} {r_out:g} 0 0 1 {cx:g} {cy - s * r_out:g}L{cx:g} {cy - s * r_in:g}A{r_in:g} {r_in:g} 0 0 0 {cx:g} {cy + s * r_in:g}Z"


def _disc(cx: float, cy: float, r: float, left: bool | None = None) -> str:
    if left is None:
        return f"M{cx - r:g} {cy:g}A{r:g} {r:g} 0 1 1 {cx + r:g} {cy:g}A{r:g} {r:g} 0 1 1 {cx - r:g} {cy:g}Z"
    s = 1 if left else -1
    return f"M{cx:g} {cy + s * r:g}A{r:g} {r:g} 0 0 1 {cx:g} {cy - s * r:g}Z"


def _segments(cx: float, cy: float, left: bool, ro: float, gap: float, corner: float, segs: int) -> str:
    d = gap / 2 + corner
    start = math.pi / 2 if left else -math.pi / 2
    step = math.pi / segs
    return "".join(_wedge(cx, cy, start + i * step, start + (i + 1) * step, ro, d) for i in range(segs))


# Three drawings of the same mark, a whole citrus slice: lemon on the left, lime on the
# right. The full one; a bolder one for 20-40 px; and one for 16 px with four segments.
DRAWINGS = {
    "full": dict(R=240, peel_w=30, pith_w=14, gap=17, corner=13, segs=4),
    "small": dict(R=246, peel_w=44, pith_w=20, gap=28, corner=16, segs=4),
    "tiny": dict(R=250, peel_w=64, pith_w=30, gap=46, corner=24, segs=2),
}


def mark_group(cx: float, cy: float, scale: float, colours: str = "colour", drawing: str = "full") -> str:
    """The mark drawn on a 512 grid, centred on (cx, cy) and scaled."""
    g = DRAWINGS[drawing]
    R, pw, ph, gap, corner, segs = g["R"], g["peel_w"], g["pith_w"], g["gap"], g["corner"], g["segs"]
    ro = R - pw - ph - corner
    lw = _segments(256, 256, True, ro, gap, corner, segs)
    rw = _segments(256, 256, False, ro, gap, corner, segs)
    flesh = lambda d, c: f'<path d="{d}" fill="{c}" stroke="{c}" stroke-width="{2 * corner:g}" stroke-linejoin="round"/>'
    if colours == "colour":
        # The lime disc sits under the lemon half, so no hairline shows where they meet.
        body = (
            f'<path d="{_disc(256, 256, R)}" fill="{LIME_PEEL}"/>'
            f'<path d="{_disc(256, 256, R, left=True)}" fill="{LEMON_PEEL}"/>'
            f'<path d="{_disc(256, 256, R - pw)}" fill="{CREAM}"/>'
            + flesh(lw, LEMON)
            + flesh(rw, LIME)
        )
    elif colours in ("ink", "cream"):
        c = INK if colours == "ink" else CREAM
        body = f'<path d="{_ring(256, 256, R, R - pw, None)}" fill="{c}" fill-rule="evenodd"/>' + flesh(lw + rw, c)
    else:
        raise ValueError(colours)
    t = f"translate({cx - 256 * scale:.3f} {cy - 256 * scale:.3f}) scale({scale:g})"
    return f'<g transform="{t}">{body}</g>'


def mark_bounds(drawing: str = "full") -> tuple[float, float, float, float]:
    R = DRAWINGS[drawing]["R"]
    return 256 - R, 256 - R, 2 * R, 2 * R


def svg(w: float, h: float, body: str, title: str | None = None) -> str:
    t = f"<title>{title}</title>" if title else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w:g}" height="{h:g}">{t}{body}</svg>\n'


# ── Files ───────────────────────────────────────────────────────────────────


def wordmark(size: float, x: float, baseline: float, colour: str) -> tuple[str, float]:
    d, w = DISPLAY.path(WORD, size, x, baseline, WORD_TRACKING)
    return f'<path d="{d}" fill="{colour}"/>', w


def lockup(colour_mark: str, colour_text: str, size: float = 100) -> tuple[str, float, float]:
    """Mark beside the wordmark. Returns body, width, height for a 100 px font size."""
    k = size / 100
    mark_h = 96 * k  # the mark's height
    gap = 22 * k
    asc = 76 * k  # top of the "l"
    scale = mark_h / mark_bounds()[3]
    mw = mark_bounds()[2] * scale
    pad_y = 4 * k
    # Centre the mark on the lower-case height, nudged a touch up so it sits optically level.
    baseline = pad_y + (mark_h + asc) / 2 + 2 * k
    m = mark_group(mw / 2, pad_y + mark_h / 2, scale, colour_mark)
    text, tw = wordmark(size, mw + gap, baseline, colour_text)
    h = mark_h + 2 * pad_y
    return m + text, mw + gap + tw, h


def stacked(colour_mark: str, colour_text: str) -> tuple[str, float, float]:
    size = 84
    _, tw = DISPLAY.path(WORD, size, 0, 0, WORD_TRACKING)
    mark_h = 230
    scale = mark_h / mark_bounds()[3]
    w = max(tw, mark_bounds()[2] * scale)
    m = mark_group(w / 2, mark_h / 2, scale, colour_mark)
    text, _ = wordmark(size, (w - tw) / 2, mark_h + 44 + 64, colour_text)
    return m + text, w, mark_h + 44 + 64 + 20


def write(name: str, content: str) -> None:
    path = os.path.join(HERE, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(content)


def app_icon(full_bleed: bool) -> str:
    """The app icon on a 1024 grid. The macOS one follows Apple's grid (824 tile, 100 margin)."""
    if full_bleed:
        x = y = 0
        size, radius = 1024, 230
    else:
        x = y = 100
        size, radius = 824, 185
    defs = (
        '<defs><radialGradient id="g" cx="0.3" cy="0.15" r="1.1">'
        f'<stop offset="0" stop-color="#26351A"/><stop offset="0.55" stop-color="{RIND_2}"/><stop offset="1" stop-color="{RIND}"/>'
        "</radialGradient></defs>"
    )
    tile = f'<rect x="{x}" y="{y}" width="{size}" height="{size}" rx="{radius}" fill="url(#g)"/>'
    edge = f'<rect x="{x + 1.5}" y="{y + 1.5}" width="{size - 3}" height="{size - 3}" rx="{radius - 1.5}" fill="none" stroke="#FFFFFF" stroke-opacity="0.07" stroke-width="3"/>'
    mark_h = size * 0.70
    scale = mark_h / mark_bounds()[3]
    return svg(1024, 1024, defs + tile + edge + mark_group(512, 512, scale), "LemonLime")


def preview(title_lines: list[str], sub_lines: list[str], footer: str | None, w: int = 1200, h: int = 630, title_size: float = 60) -> str:
    """A link preview: words on the left, a large slice on the right running off the edge."""
    body = [f'<rect width="{w}" height="{h}" fill="{CREAM}"/>']
    k = h / 630
    # The slice, whole, on the right.
    big = h * 0.70
    scale = big / mark_bounds()[3]
    half_w = mark_bounds()[2] * scale / 2
    body.append(mark_group(w - half_w - 64 * k, h / 2, scale))
    # Logo lockup top left.
    lk, lw, lh = lockup("colour", INK, 44 * k)
    body.append(f'<g transform="translate({72 * k:g} {60 * k:g})">{lk}</g>')
    y = 60 * k + lh + (104 if sub_lines else 150) * k
    size = title_size * k
    for line in title_lines:
        d, _ = DISPLAY.path(line, size, 70 * k, y, -0.035)
        body.append(f'<path d="{d}" fill="{INK}"/>')
        y += size * 1.06
    y += 20 * k
    for line in sub_lines:
        d, _ = BODY.path(line, 26 * k, 72 * k, y, -0.01)
        body.append(f'<path d="{d}" fill="{INK_2}"/>')
        y += 27 * k * 1.42
    if footer:
        d, _ = BODY_BOLD.path(footer, 26 * k, 72 * k, h - 60 * k, -0.005)
        body.append(f'<path d="{d}" fill="{INK}"/>')
    return svg(w, h, "".join(body))


def react_mark() -> str:
    """The mark as a React component, so the apps draw it without loading a file."""
    parts = {}
    for drawing in ("full", "small"):
        _, _, w, h = mark_bounds(drawing)
        body = mark_group(w / 2, h / 2, 1, "colour", drawing).replace("stroke-width", "strokeWidth").replace("stroke-linejoin", "strokeLinejoin")
        parts[drawing] = (w, h, body)
    fw, fh, fb = parts["full"]
    sw, sh, sb = parts["small"]
    return f"""// Drawn by brand/build.py. Don't edit by hand: change the script and run it again.

/** The LemonLime mark: one citrus slice, lemon on the left and lime on the right. Sizes up to 40 px use a bolder drawing. */
export function LogoMark({{ size = 24, className = "" }}: {{ size?: number; className?: string }}) {{
  const small = size <= 40;
  const [w, h] = small ? [{sw:g}, {sh:g}] : [{fw:g}, {fh:g}];
  return (
    <svg aria-hidden="true" focusable="false" viewBox={{`0 0 ${{w}} ${{h}}`}} width={{(size * w) / h}} height={{size}} className={{`shrink-0 ${{className}}`}}>
      {{small ? (
        {sb.replace('"/>', '" />')}
      ) : (
        {fb.replace('"/>', '" />')}
      )}}
    </svg>
  );
}}
"""


def main() -> None:
    bx, by, bw, bh = mark_bounds()
    pad = 16
    for name, colours in (("mark.svg", "colour"), ("mark-ink.svg", "ink"), ("mark-cream.svg", "cream")):
        write(name, svg(bw + 2 * pad, bh + 2 * pad, mark_group((bw + 2 * pad) / 2, (bh + 2 * pad) / 2, 1, colours), "LemonLime"))
    for drawing in ("small", "tiny"):
        sh = mark_bounds(drawing)[3]
        write(f"mark-{drawing}.svg", svg(512, 512, mark_group(256, 256, 500 / sh, "colour", drawing), "LemonLime"))

    for name, mc, tc in (("wordmark.svg", None, INK), ("wordmark-cream.svg", None, CREAM)):
        _, tw = DISPLAY.path(WORD, 100, 0, 0, WORD_TRACKING)
        text, _ = wordmark(100, 4, 80, tc)
        write(name, svg(tw + 8, 104, text, "LemonLime"))
    for name, mc, tc in (("lockup.svg", "colour", INK), ("lockup-on-dark.svg", "colour", CREAM), ("lockup-ink.svg", "ink", INK), ("lockup-cream.svg", "cream", CREAM)):
        body, w, h = lockup(mc, tc)
        write(name, svg(w, h, body, "LemonLime"))
    for name, mc, tc in (("lockup-stacked.svg", "colour", INK), ("lockup-stacked-on-dark.svg", "colour", CREAM)):
        body, w, h = stacked(mc, tc)
        write(name, svg(w, h, body, "LemonLime"))

    mark_tsx = react_mark()
    for target in ("apps/web/src/components/logo-mark.tsx", "apps/desktop/src/components/LogoMark.tsx"):
        with open(os.path.join(ROOT, target), "w") as f:
            f.write(mark_tsx)

    write("app-icon.svg", app_icon(full_bleed=False))
    write("app-icon-square.svg", app_icon(full_bleed=True))

    # The open-source preview (GitHub, the dashboard). Nothing about any hosted service.
    write(
        "preview.svg",
        preview(HEADLINE, [], "Open source, MIT", title_size=62),
    )
    write(
        "preview-github.svg",
        preview(HEADLINE, [], "Open source, MIT", 1280, 640, title_size=62),
    )


if __name__ == "__main__":
    main()
