import { Channel, NewMessage } from './types.js';
import { formatLocalTime, resolveTimezone } from './timezone.js';
import { parseTextStyles, ChannelType } from './text-styles.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Return today's date (YYYY-MM-DD) and local weekday (pt-BR) in the given tz.
// LLMs are unreliable at date→weekday arithmetic; exposing both lets them
// resolve relative-weekday asks ("quinta-feira") deterministically.
//
// formatMessages runs on every inbound message, so the formatters are cached
// per resolved timezone — construction costs ~0.5 ms each and the set of
// active timezones is bounded by the number of registered boards.
const formatterCache = new Map<
  string,
  { dateFmt: Intl.DateTimeFormat; wkFmt: Intl.DateTimeFormat }
>();

function getFormatters(tz: string): {
  dateFmt: Intl.DateTimeFormat;
  wkFmt: Intl.DateTimeFormat;
} {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const dateFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const wkFmt = new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz,
    weekday: 'long',
  });
  const entry = { dateFmt, wkFmt };
  formatterCache.set(tz, entry);
  return entry;
}

export function localDateAndWeekday(
  timezone: string,
  now: Date = new Date(),
): { today: string; weekday: string } {
  const tz = resolveTimezone(timezone);
  const { dateFmt, wkFmt } = getFormatters(tz);
  const parts = Object.fromEntries(
    dateFmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = wkFmt.format(now);
  return { today, weekday };
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string = 'UTC',
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const { today, weekday } = localDateAndWeekday(timezone);
  const header = `<context timezone="${escapeXml(timezone)}" today="${escapeXml(today)}" weekday="${escapeXml(weekday)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  // Strip properly closed <internal>...</internal> blocks.
  // Case-insensitive so mixed-case variants (<Internal>, <INTERNAL>) from the
  // LLM cannot leak hidden reasoning to the outbound channel.
  let result = text.replace(/<internal>[\s\S]*?<\/internal>/gi, '');
  // Strip unclosed <internal> tags — only consume non-< chars to avoid
  // destroying content after a literal "<internal>" in prose text
  result = result.replace(/<internal>[^<]*/gi, '');
  return result.trim();
}

export function formatOutbound(rawText: string, channel?: ChannelType): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return channel ? parseTextStyles(text, channel) : text;
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
