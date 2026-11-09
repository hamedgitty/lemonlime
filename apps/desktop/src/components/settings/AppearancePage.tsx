import { NAV_ITEMS, type NavItem } from "../../lib/storage.ts";
import { SegmentedControl } from "../ui.tsx";
import type { SettingsCtx } from "./context.ts";
import { Row, Section, ToggleRow } from "./parts.tsx";

const NAV_LABELS: Record<NavItem, string> = {
  new: "New thread",
  search: "Search threads",
  skills: "Skills",
  plugins: "Plugins",
  automations: "Automations",
};

export function AppearancePage({ ctx }: { ctx: SettingsCtx }) {
  const { prefs, onPrefs } = ctx;
  return (
    <>
      <Section title="Sidebar" description="Drag items into your own order from More → Customize sidebar.">
        {NAV_ITEMS.map(item => (
          <ToggleRow
            key={item}
            label={`Show ${NAV_LABELS[item]}`}
            {...(item === "search" ? { description: "Search is always one ⌘K away." } : {})}
            checked={!prefs.hiddenNav.includes(item)}
            onChange={on => onPrefs({ hiddenNav: on ? prefs.hiddenNav.filter(x => x !== item) : [...prefs.hiddenNav, item] })}
          />
        ))}
        <ToggleRow
          label="Show each thread's agent"
          description="A small mark for Claude Code, Codex, OpenCode or ACP in place of the computer or cloud icon."
          checked={prefs.agentIcons}
          onChange={agentIcons => onPrefs({ agentIcons })}
        />
        <ToggleRow
          label="List subagents under their thread"
          description="Each subagent gets its own line under the thread that started it. Turn this off to keep just the small progress grid on the thread's row."
          checked={!prefs.collapseChildren}
          onChange={on => onPrefs({ collapseChildren: !on })}
        />
      </Section>
      <Section title="Threads list">
        <Row label="Group threads">
          <SegmentedControl
            label="Group threads"
            value={prefs.organize}
            onChange={organize => onPrefs({ organize })}
            options={[
              { value: "project", label: "Project" },
              { value: "place", label: "Where" },
              { value: "agent", label: "Agent" },
            ]}
          />
        </Row>
        <Row label="Sort threads">
          <SegmentedControl
            label="Sort threads"
            value={prefs.sort}
            onChange={sort => onPrefs({ sort })}
            options={[
              { value: "recent", label: "Recent" },
              { value: "name", label: "Name" },
            ]}
          />
        </Row>
      </Section>
      <Section title="Conversations">
        <ToggleRow
          label="Fold finished turns"
          description="Once the agent is done, its steps fold into one line you can open. The last turn always stays open."
          checked={prefs.collapseFinished}
          onChange={collapseFinished => onPrefs({ collapseFinished })}
        />
        <ToggleRow
          label="Dim inactive panes in split view"
          description="With threads side by side, the ones you aren't typing in sit back a little."
          checked={prefs.dimInactivePanes}
          onChange={dimInactivePanes => onPrefs({ dimInactivePanes })}
        />
      </Section>
      <Section title="Home">
        <ToggleRow
          label="Always show one-click prompts"
          description="Ready-made first messages under the message box. Off, they go away once you've started a few threads."
          checked={prefs.keepStarterPrompts}
          onChange={keepStarterPrompts => onPrefs({ keepStarterPrompts })}
        />
      </Section>
    </>
  );
}
