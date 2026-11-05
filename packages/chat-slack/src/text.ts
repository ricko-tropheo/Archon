/**
 * Slack mrkdwn treats `<...>` as an entity (mention, channel, or link). Any
 * model- or provider-authored text crossing the Slack boundary must be escaped
 * or it can page a channel or inject a link. Escape `&` first so the entities
 * introduced below are not double-escaped.
 */
export function escapeSlackText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
