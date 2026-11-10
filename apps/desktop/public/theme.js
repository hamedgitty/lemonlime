// Sets light or dark on <html> before the app's first paint, so the window never flashes
// the wrong colours. The choice is Settings → Appearance → Theme ("system" follows macOS,
// Windows or Linux); lib/theme.ts keeps it current after that.
(() => {
  let choice = "system";
  try {
    choice = JSON.parse(localStorage.getItem("lemonlime:ui") || "{}").theme || "system";
  } catch {
    /* unreadable prefs: follow the system */
  }
  const dark = choice === "dark" || (choice !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
})();
