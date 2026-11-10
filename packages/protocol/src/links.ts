/** True for a host only this computer can reach: localhost, 127.0.0.1, [::1], or a name ending in .localhost. */
export function isThisComputer(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * The link, if it is safe to offer as something to click; otherwise null. A link that comes
 * from a sandbox or from a deployment's plugin is only shown when it can't be anything but
 * an ordinary web page: https, or plain http for an address on this computer.
 */
export function safeLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === "https:") return url;
    return protocol === "http:" && isThisComputer(hostname) ? url : null;
  } catch {
    return null;
  }
}

/** True for a link that starts an email to one address and fills in nothing else: no subject, no text, nobody copied in. */
function writesToOneAddress(url: string): boolean {
  return /^mailto:[^\s@?#&,;%<>"']+@[^\s@?#&,;%<>"']+$/i.test(url);
}

/**
 * The link a deployment's plugin offers next to a message ("Add hours", "Contact us"), if it
 * is safe to offer: a web page as above, or an email address to write to.
 */
export function safeActionLink(url: string | null | undefined): string | null {
  return safeLink(url) ?? (url && writesToOneAddress(url) ? url : null);
}

/** The same thing, without its link and the link's label unless the link is safe to offer. */
export function withSafeLink<T extends { actionUrl?: string; actionLabel?: string }>(item: T): T {
  if (safeActionLink(item.actionUrl)) return item;
  const { actionUrl: _url, actionLabel: _label, ...rest } = item;
  return rest as T;
}
