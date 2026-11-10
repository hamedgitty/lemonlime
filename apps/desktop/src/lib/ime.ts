/**
 * Whether a key press belongs to an input method that is still putting a word together
 * (Japanese, Chinese, Korean and others). Enter then picks a candidate: it must not send
 * or submit. WebKit reports that Enter as already finished, with the old key code 229.
 */
export function composing(e: { nativeEvent?: { isComposing?: boolean }; isComposing?: boolean; keyCode?: number }): boolean {
  return Boolean(e.nativeEvent?.isComposing ?? e.isComposing) || e.keyCode === 229;
}
