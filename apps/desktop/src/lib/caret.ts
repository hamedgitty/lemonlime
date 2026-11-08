/**
 * Where the caret is in a textarea, in pixels from the textarea's top-left corner (minus
 * its scroll). Measured with a hidden copy of the box that has the same text layout.
 */

const COPIED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "fontFeatureSettings",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "tabSize",
] as const;

export function caretCoordinates(el: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const mirror = document.createElement("div");
  const style = getComputedStyle(el);
  for (const p of COPIED) mirror.style[p] = style[p];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    overflow: "hidden",
    height: "auto",
  });
  mirror.textContent = el.value.slice(0, position);
  const marker = document.createElement("span");
  // Something to measure even at the end of a line.
  marker.textContent = el.value.slice(position) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const out = { top: marker.offsetTop - el.scrollTop, left: marker.offsetLeft - el.scrollLeft, height: lineHeight };
  mirror.remove();
  return out;
}
