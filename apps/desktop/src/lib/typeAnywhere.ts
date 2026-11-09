/**
 * Typing or pasting while nothing that takes text has focus lands in the thread's message
 * box. Fields, focused buttons, open dialogs and menus, and the terminal keep their keys.
 */

export interface FocusFacts {
  /** A text field, select or editable area (the terminal's hidden input counts). */
  editable: boolean;
  /** A button, link or other control that acts on keys (Space and Enter press it). */
  control: boolean;
  /** Inside the terminal. */
  terminal: boolean;
  /** A dialog or menu is open over the page. */
  overlay: boolean;
}

/** Whether a key press should go to the message box. */
export function typingGoesToComposer(
  e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; isComposing?: boolean; defaultPrevented?: boolean },
  focus: FocusFacts,
): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented) return false;
  // One printable character; Space on its own scrolls the page.
  if ([...e.key].length !== 1 || e.key === " ") return false;
  return pasteGoesToComposer(focus);
}

/** Whether a paste should go to the message box. */
export const pasteGoesToComposer = (focus: FocusFacts) => !focus.editable && !focus.control && !focus.terminal && !focus.overlay;

const CONTROL =
  'button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [role="combobox"], [role="treeitem"]';
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]:not([data-composer] *)';

/** The facts above, read from the page. */
export function focusFacts(doc: Document = document): FocusFacts {
  const el = doc.activeElement instanceof HTMLElement && doc.activeElement !== doc.body ? doc.activeElement : null;
  return {
    editable: Boolean(el && (el.isContentEditable || el.matches("input, textarea, select"))),
    control: Boolean(el?.closest(CONTROL)),
    terminal: Boolean(el?.closest(".xterm")),
    overlay: [...doc.querySelectorAll<HTMLElement>(OVERLAY)].some(o => o.getClientRects().length > 0),
  };
}
