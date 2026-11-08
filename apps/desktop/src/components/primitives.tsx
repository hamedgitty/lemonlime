import type { ReactElement, ReactNode } from "react";
import { Menu as BaseMenu } from "@base-ui/react/menu";
import { Popover as BasePopover } from "@base-ui/react/popover";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { Check, ChevronRight } from "lucide-react";
import { cx } from "./ui.tsx";

/**
 * Styled Base UI primitives in LemonLime's tokens. Keyboard handling, focus and
 * screen-reader behaviour come from Base UI; only the look lives here.
 */

type Side = "top" | "bottom" | "left" | "right";
type Align = "start" | "center" | "end";

const POPUP =
  "z-50 min-w-[11rem] rounded-[10px] border border-line bg-paper p-1 text-[14px] text-ink shadow-pop outline-none origin-(--transform-origin) transition-[opacity,scale] duration-150 ease-(--ease-out) data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0";

const ITEM =
  "flex h-8 cursor-default select-none items-center gap-2.5 rounded-[7px] px-2.5 outline-none data-[highlighted]:bg-cream-deep data-[disabled]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-ink-faint";

export function Menu({
  trigger,
  children,
  side = "bottom",
  align = "start",
  sideOffset = 6,
  className,
}: {
  /** The element that opens the menu (rendered by Base UI's trigger). */
  trigger: ReactElement;
  children: ReactNode;
  side?: Side;
  align?: Align;
  sideOffset?: number;
  className?: string;
}) {
  return (
    <BaseMenu.Root>
      <BaseMenu.Trigger render={trigger} />
      <BaseMenu.Portal>
        <BaseMenu.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
          <BaseMenu.Popup className={cx(POPUP, className)}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

export function MenuItem({
  icon,
  children,
  onSelect,
  disabled,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <BaseMenu.Item className={ITEM} onClick={onSelect} disabled={disabled}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[12.5px] text-ink-faint">{hint}</span>}
    </BaseMenu.Item>
  );
}

export function MenuSeparator() {
  return <BaseMenu.Separator className="mx-1 my-1 h-px bg-line" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  // A plain heading: Base UI's GroupLabel throws outside a Group.
  return (
    <div role="presentation" className="px-2.5 pt-1.5 pb-1 text-[12.5px] font-medium text-ink-faint">
      {children}
    </div>
  );
}

/** One-of-many choices inside a menu, each with a check when chosen. */
export function MenuChoice<T extends string>({
  value,
  onChange,
  options,
  closeOnClick = false,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; icon?: ReactNode }[];
  /** Close the menu once a choice is picked (pickers), instead of staying open (settings). */
  closeOnClick?: boolean;
}) {
  return (
    <BaseMenu.RadioGroup value={value} onValueChange={v => onChange(v as T)}>
      {options.map(o => (
        <BaseMenu.RadioItem key={o.value} value={o.value} className={ITEM} closeOnClick={closeOnClick}>
          {o.icon}
          <span className="min-w-0 flex-1 truncate">{o.label}</span>
          <BaseMenu.RadioItemIndicator keepMounted className="data-[unchecked]:invisible">
            <Check aria-hidden="true" className="!text-leaf" />
          </BaseMenu.RadioItemIndicator>
        </BaseMenu.RadioItem>
      ))}
    </BaseMenu.RadioGroup>
  );
}

/** A submenu row ("Organize ›"). */
export function SubMenu({ icon, label, children }: { icon?: ReactNode; label: ReactNode; children: ReactNode }) {
  return (
    <BaseMenu.SubmenuRoot>
      <BaseMenu.SubmenuTrigger className={ITEM}>
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <ChevronRight aria-hidden="true" />
      </BaseMenu.SubmenuTrigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner side="right" align="start" sideOffset={4} className="z-50">
          <BaseMenu.Popup className={POPUP}>{children}</BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.SubmenuRoot>
  );
}

/**
 * Tooltip in the brand accent: lime fill, ink text. No arrow. Appears instantly after the
 * first one (shared delay), never on keyboard focus alone for frequent controls.
 */
export function Tip({ label, children, side = "top" }: { label: ReactNode; children: ReactElement; side?: Side }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner side={side} sideOffset={8} className="z-50">
          <BaseTooltip.Popup className="rounded-[7px] bg-lime px-2.5 py-1 text-[13.5px] font-medium text-ink shadow-[0_4px_14px_rgb(23_32_14/0.14)] transition-opacity duration-100 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

export const TipProvider = ({ children }: { children: ReactNode }) => <BaseTooltip.Provider delay={350}>{children}</BaseTooltip.Provider>;

export function Popover({
  trigger,
  children,
  side = "bottom",
  align = "start",
  className,
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  side?: Side;
  align?: Align;
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <BasePopover.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange: (o: boolean) => onOpenChange(o) } : {})}>
      <BasePopover.Trigger render={trigger} />
      <BasePopover.Portal>
        <BasePopover.Positioner side={side} align={align} sideOffset={6} className="z-50">
          <BasePopover.Popup className={cx(POPUP, "p-0", className)}>{children}</BasePopover.Popup>
        </BasePopover.Positioner>
      </BasePopover.Portal>
    </BasePopover.Root>
  );
}

/** On/off switch: lime when on. Label it with aria-labelledby or a wrapping label. */
export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <BaseSwitch.Root
      checked={checked}
      onCheckedChange={v => onChange(Boolean(v))}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-[34px] shrink-0 items-center rounded-full border border-control bg-cream-deep transition-colors duration-150 data-[checked]:border-[#6fa31c] data-[checked]:bg-lime data-[disabled]:opacity-50"
    >
      <BaseSwitch.Thumb className="block size-3.5 translate-x-[2px] rounded-full bg-control transition-transform duration-150 ease-(--ease-out) data-[checked]:translate-x-[16px] data-[checked]:bg-ink" />
    </BaseSwitch.Root>
  );
}

/** A small key cap, e.g. "Esc" or "⌘ ,". */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-paper px-1.5 font-sans text-[12px] font-medium text-ink-soft">
      {children}
    </kbd>
  );
}
