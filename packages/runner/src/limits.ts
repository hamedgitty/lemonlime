import type { NewEvent } from "@lemonlime/protocol";

/** Largest agent message we keep. Longer ones are cut, with a note saying so. */
export const MAX_MESSAGE_CHARS = 512 * 1024;
/** Largest tool input or output we keep, measured as JSON. */
export const MAX_TOOL_CHARS = 256 * 1024;

/**
 * Keep every event small enough to store, replay and send over a WebSocket. Agents
 * sometimes print megabytes (a `cat` of a log, a huge JSON blob); the history keeps the
 * start of it and says how much was left out.
 */
export function capEvent(event: NewEvent): NewEvent {
  switch (event.type) {
    case "agent_message":
      return event.text.length > MAX_MESSAGE_CHARS ? { ...event, text: cutText(event.text, MAX_MESSAGE_CHARS) } : event;
    case "tool_call":
      return { ...event, input: capValue(event.input) };
    case "tool_result":
      return { ...event, output: capValue(event.output) };
    default:
      return event;
  }
}

/** Strings are cut; other values that are too large become a cut JSON preview. */
export function capValue(value: unknown, max = MAX_TOOL_CHARS): unknown {
  if (typeof value === "string") return value.length > max ? cutText(value, max) : value;
  if (value === null || value === undefined || typeof value !== "object") return value;
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return "[output could not be recorded]";
  }
  return json.length > max ? cutText(json, max) : value;
}

function cutText(text: string, max: number): string {
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n[${omitted.toLocaleString("en-US")} more characters not kept]`;
}
