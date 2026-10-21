import { Presentation, defaultPresentation } from './presentation';
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

function nameLine(name: string): string {
  return name.replace(/[\r\n\u2028\u2029]+/g, ' ');
}
function markdown(name: string): string {
  return name.replace(/([\\`*_{}[\]()<>#+.!|~-])/g, '\\$1');
}
function iso(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function assembleBatch(
  id: string,
  channel: string,
  pending: StoredMessage[],
  maxChars: number,
  now = Date.now(),
  options: Presentation = defaultPresentation,
  roomLabel?: string,
): { payload: string; members: BatchMember[] } {
  if (options.roomLabel && !roomLabel)
    throw new Error('Discord room label is not available yet');
  const lines: string[] = [];
  const members: BatchMember[] = [];
  const speakers = new Map<string, string>();
  const keyFor = (m: StoredMessage) =>
    JSON.stringify([nameLine(m.speaker), m.author_id]);
  const owners = new Map<string, Set<string>>();
  for (const m of pending) {
    const name = nameLine(m.speaker);
    if (!owners.has(name)) owners.set(name, new Set());
    owners.get(name)!.add(m.author_id);
  }
  const labels = new Map<string, string>();
  const reserved = new Set(owners.keys());
  for (const m of pending) {
    const key = keyFor(m),
      name = nameLine(m.speaker);
    if (labels.has(key)) continue;
    let label = name;
    if (owners.get(name)!.size > 1) {
      label = `${name} (${m.author_id})`;
      while (reserved.has(label)) label += '_';
      reserved.add(label);
    }
    labels.set(key, label);
  }
  const room = [
    options.roomLabel ? `#${nameLine(roomLabel!)}` : '',
    options.roomId ? channel : '',
  ]
    .filter(Boolean)
    .join(' | ');
  let completed = 0;
  const header = (remaining: number, mapping: Map<string, string>) =>
    [
      iso(now),
      ...(room ? [room] : []),
      `${id} | ${remaining}`,
      '',
      [...mapping].map(([name, author]) => `${author} ${name}`).join('\n'),
    ].join('\n') + '\n\n';
  for (const message of pending) {
    const label = labels.get(keyFor(message))!;
    const mapping = new Map(speakers).set(label, message.author_id);
    const stamp = iso(message.timestamp);
    const heading = [
      options.messageId ? message.id : '',
      options.date ? `${stamp.slice(5, 7)}/${stamp.slice(8, 10)}` : '',
      options.time ? stamp.slice(11, 16) : '',
      `**${markdown(label)}**`,
    ]
      .filter(Boolean)
      .join(' ');
    const lineFor = (end: number) => {
      const edit = message.version ? ` [~${iso(message.version)}]` : '';
      const fragment =
        message.offset || end < message.content.length
          ? ` [${message.offset}|${end < message.content.length ? 'more' : 'end'}]`
          : '';
      return `${heading}${edit}${fragment}\n${message.content.slice(message.offset, end)}`;
    };
    const payload = (end: number, remaining: number) =>
      header(remaining, mapping) + [...lines, lineFor(end)].join('\n\n');
    let end = message.content.length;
    if (payload(end, pending.length - completed - 1).length > maxChars) {
      if (members.length) break;
      let lo = message.offset,
        hi = message.content.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (
          payload(safeEnd(message.content, mid), pending.length).length <=
          maxChars
        )
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
    speakers.set(label, message.author_id);
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
  const result =
    header(pending.length - completed, speakers) + lines.join('\n\n');
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
