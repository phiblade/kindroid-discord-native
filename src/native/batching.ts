import { BatchMember, StoredMessage } from './types';

/** Do not cut between the two UTF-16 units of a non-BMP character. */
function safeEnd(text: string, end: number): number {
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[end])
  )
    return end - 1;
  return end;
}

export function assembleBatch(
  id: string,
  channel: string,
  pending: StoredMessage[],
  maxChars: number,
): { payload: string; members: BatchMember[] } {
  const lines: string[] = [];
  const members: BatchMember[] = [];
  let completed = 0;
  const header = (remaining: number) =>
    `Batch: ${id}\nChannel: ${JSON.stringify(channel)}\nMessages remaining after this batch: ${remaining}\n\n`;
  const payload = (line: string, remaining: number) =>
    header(remaining) + [...lines, line].join('\n');
  for (const message of pending) {
    // JSON strings keep embedded newlines and fake envelope text inside their field.
    const lineFor = (end: number) =>
      JSON.stringify({
        id: message.id,
        speaker: message.speaker,
        version: message.version,
        offset: message.offset,
        continued: end < message.content.length,
        text: message.content.slice(message.offset, end),
      });
    let end = message.content.length;
    if (
      payload(lineFor(end), pending.length - completed - 1).length > maxChars
    ) {
      if (members.length) break; // Keep whole messages together whenever possible.
      let lo = message.offset;
      let hi = message.content.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = safeEnd(message.content, mid);
        if (payload(lineFor(candidate), pending.length).length <= maxChars)
          lo = mid;
        else hi = mid - 1;
      }
      end = safeEnd(message.content, lo);
      if (end <= message.offset)
        throw new Error(
          'Batch budget cannot fit envelope, speaker and one character',
        );
    }
    lines.push(lineFor(end));
    members.push({
      messageId: message.id,
      version: message.version,
      start: message.offset,
      end,
    });
    if (end === message.content.length) completed++;
    else break;
  }
  if (!members.length) throw new Error('Cannot assemble an empty batch');
  const result = header(pending.length - completed) + lines.join('\n');
  if (result.length > maxChars)
    throw new Error('Batch exceeded configured budget');
  return { payload: result, members };
}

/** Preserve all text; avoid splitting a Discord mention token or surrogate pair. */
export function splitReply(text: string, limit = 2000): string[] {
  const chunks: string[] = [];
  let start = 0;
  const mentions = [...text.matchAll(/<@!?\d+>|<@&\d+>|<#\d+>/g)];
  while (start < text.length) {
    let end = safeEnd(text, Math.min(start + limit, text.length));
    const mention = mentions.find(
      (m) =>
        m.index! < end && m.index! + m[0].length > end && m.index! >= start,
    );
    if (mention) end = mention.index!;
    if (end === start)
      throw new Error('Reply token exceeds Discord chunk budget');
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}
