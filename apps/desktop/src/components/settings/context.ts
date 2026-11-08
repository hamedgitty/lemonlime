import type { CloudApi } from "../../lib/cloud.ts";
import type { LocalThreadMeta, Settings, UiPrefs } from "../../lib/storage.ts";
import type { AgentInstall } from "../../lib/system.ts";
import type { ThreadSummary } from "../../lib/threads.ts";
import type { PhoneAccess } from "../../lib/usePhoneLink.ts";

/** Everything a Settings page may read or change. */
export interface SettingsCtx {
  settings: Settings;
  onSave: (s: Settings) => void;
  prefs: UiPrefs;
  onPrefs: (p: Partial<UiPrefs>) => void;
  justSignedIn: boolean;
  cloudApi: CloudApi | null;
  /** Every thread the app knows, archived ones included. */
  threads: ThreadSummary[];
  localThreads: LocalThreadMeta[];
  onUnarchive: (t: ThreadSummary) => void;
  onOpenThread: (t: ThreadSummary) => void;
  /** Agent CLIs found on this computer (null while looking). */
  agents: AgentInstall[] | null;
  refreshAgents: () => void;
  onSignOut: () => void;
  /** Phone access to this computer's threads (Settings → General). */
  phone?: PhoneAccess;
  /** Adds threads made by importing chats. */
  onImported: (metas: LocalThreadMeta[]) => void;
  /** Opens another Settings page. */
  onPage: (page: string) => void;
  /** Opens the setup wizard again. */
  onOpenSetup: () => void;
}
