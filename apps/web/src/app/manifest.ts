import type { MetadataRoute } from "next";

/** Lets phones add the dashboard to the home screen as an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LemonLime",
    short_name: "LemonLime",
    description: "Run coding agents on your computer or in isolated cloud sandboxes.",
    start_url: "/",
    display: "standalone",
    background_color: "#FFFBEA",
    theme_color: "#FFFBEA",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
