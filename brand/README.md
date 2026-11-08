# LemonLime brand kit

The logo, icons and link previews for LemonLime, all drawn by [`build.py`](build.py) so
every size stays exact.

## The mark

One citrus slice: lemon on the left, lime on the right. Two halves, one app — your own
computer and the cloud.

| File | Use |
| --- | --- |
| `mark.svg` | The mark, full colour. Anywhere 48 px and up. |
| `mark-small.svg` | Bolder drawing for 20–40 px (sidebars, the SVG favicon). |
| `mark-tiny.svg` | Four segments, for 16 px only (inside `favicon.ico`). |
| `mark-ink.svg`, `mark-cream.svg` | One colour, for print, embossing or busy photos. |
| `wordmark.svg`, `wordmark-cream.svg` | The name alone. |
| `lockup.svg`, `lockup-on-dark.svg` | Mark and name side by side: the default logo. |
| `lockup-ink.svg`, `lockup-cream.svg` | One-colour lockups. |
| `lockup-stacked.svg`, `lockup-stacked-on-dark.svg` | Square spaces: avatars, slides, stickers. |
| `app-icon.svg` | The desktop app icon on Apple's grid (824 tile on 1024). |
| `app-icon-square.svg` | The same tile filling the square, for Windows and Linux. |
| `preview.svg`, `preview-github.svg` | Link previews (1200×630, and 1280×640 for GitHub). |
| `png/` | Every one of the above as PNG, plus `favicon.ico`, `apple-touch-icon.png` and the 192/512 home-screen icons. |

### Rules

- Keep clear space around the mark of at least a quarter of its width.
- The smallest sizes: mark 16 px, lockup 80 px wide.
- Don't recolour, rotate, outline, add shadows, split the halves apart or swap the
  lemon and lime sides.
- On photos or busy backgrounds use the one-colour version.

## The name

Written **LemonLime** in sentences. The wordmark is set lower case — `lemonlime` — in
Bricolage Grotesque ExtraBold with −0.03 em tracking, and is drawn as outlines so it
never depends on the font being installed.

## Colour

| Name | Hex | Use |
| --- | --- | --- |
| Cream | `#FFFBEA` | Backgrounds |
| Ink | `#17200E` | Text, the one-colour mark |
| Ink 2 | `#4B5637` | Secondary text |
| Rind | `#11190A` | Dark surfaces, the app icon tile |
| Lemon | `#FFE135` | Lemon flesh, highlights |
| Lemon peel | `#FFD60A` | Lemon peel |
| Lime | `#A3E635` | Lime flesh, success |
| Lime peel | `#7CC81E` | Lime peel |
| Leaf | `#3F7A16` | Green text and links on light backgrounds |

Lemon and lime are fills, never text on a light background; use Leaf for green text.

## Type

- **Bricolage Grotesque** (700–800) for headings and the wordmark.
- **Inter** (400–600) for everything else.
- A monospace font only for code, branch names and IDs.

All three are free under the SIL Open Font Licence.

## Rebuilding

```bash
pip3 install --user fonttools uharfbuzz brotli
pnpm install
python3 brand/build.py   # the SVGs, and the React LogoMark in both apps
node brand/render.mjs    # PNG, ICO and ICNS, copied into apps/web and apps/desktop
```
