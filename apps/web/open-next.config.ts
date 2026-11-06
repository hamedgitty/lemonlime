import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page and route in the control plane is dynamic, so no incremental cache is configured.
export default defineCloudflareConfig({});
