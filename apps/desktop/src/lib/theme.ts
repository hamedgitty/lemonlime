/** Light or dark: the user's choice from Settings → Appearance, or the system's. */
export type ThemeChoice = "system" | "light" | "dark";

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function resolveTheme(choice: ThemeChoice, systemDark: boolean): "light" | "dark" {
  return choice === "system" ? (systemDark ? "dark" : "light") : choice;
}

/** Puts the theme on <html> and, for "system", follows the system as it changes. Returns a cleanup. */
export function applyTheme(choice: ThemeChoice): () => void {
  const mq = media();
  const set = () => document.documentElement.setAttribute("data-theme", resolveTheme(choice, mq.matches));
  set();
  if (choice !== "system") return () => {};
  mq.addEventListener("change", set);
  return () => mq.removeEventListener("change", set);
}
