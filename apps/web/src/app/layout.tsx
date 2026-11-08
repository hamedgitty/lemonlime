import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/inter";
import "@fontsource-variable/bricolage-grotesque";
import "./globals.css";
import { getAppContext } from "@/lib/env.ts";

const DESCRIPTION = "Run Claude Code, Codex, OpenCode and any ACP agent on your computer or in isolated cloud sandboxes.";

/** Link previews need absolute addresses, so they're built from this deployment's public URL. */
export async function generateMetadata(): Promise<Metadata> {
  let base: URL | undefined;
  try {
    const url = (await getAppContext()).vars.LEMONLIME_PUBLIC_URL;
    base = url ? new URL(url) : undefined;
  } catch {
    base = undefined;
  }
  return {
    metadataBase: base,
    title: { default: "LemonLime", template: "%s · LemonLime" },
    description: DESCRIPTION,
    applicationName: "LemonLime",
    appleWebApp: { title: "LemonLime", statusBarStyle: "default" },
    openGraph: { type: "website", siteName: "LemonLime", title: "LemonLime", description: DESCRIPTION },
    twitter: { card: "summary_large_image", title: "LemonLime", description: DESCRIPTION },
  };
}

export const viewport: Viewport = { themeColor: "#FFFBEA", colorScheme: "light" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
