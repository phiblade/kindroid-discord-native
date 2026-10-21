import { TextChannel, DMChannel, Message } from "discord.js";
import { ConversationMessage } from "./types";

// Track message cache with proper typing
interface CacheEntry {
  contextSize: number;
  messages: Map<string, Message>;
}

// Cache for display names
interface DisplayNameCacheEntry {
  displayName: string;
  lastFetchTime: number;
}

// In-memory cache for recent message fetches
const channelCache = new Map<string, CacheEntry>();
const pendingFetches = new Map<string, Promise<ConversationMessage[]>>();
// Cache for display names - key is guildId:userId
const displayNameCache = new Map<string, DisplayNameCacheEntry>();

const DISPLAY_NAME_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Gets the display name for a message author with proper member fetching
 * @param msg - Discord message
 * @returns The most appropriate display name
 */
async function getUserDisplayName(msg: Message): Promise<string> {
  try {
    // Check cache first
    const cacheKey = msg.guildId
      ? `${msg.guildId}:${msg.author.id}`
      : msg.author.id;
    const now = Date.now();
    const cached = displayNameCache.get(cacheKey);

    if (cached && now - cached.lastFetchTime < DISPLAY_NAME_CACHE_DURATION) {
      return cached.displayName;
    }

    let displayName: string;

    // If in a guild, try to get server nickname
    if (msg.guildId) {
      try {
        const guild = msg.client.guilds.cache.get(msg.guildId);
        if (!guild) {
          throw new Error("Guild not found in cache");
        }

        const member = await guild.members.fetch(msg.author.id);
        if (member && member.nickname) {
          displayName = member.nickname;
        } else if (msg.author.globalName) {
          displayName = msg.author.globalName;
        } else {
          displayName = msg.author.username;
        }
      } catch (error) {
        console.error("Error fetching guild member:", error);
        displayName = msg.author.globalName || msg.author.username;
      }
    } else {
      displayName = msg.author.globalName || msg.author.username;
    }

    // Update cache
    displayNameCache.set(cacheKey, {
      displayName,
      lastFetchTime: now,
    });

    // Clean old cache entries periodically
    if (displayNameCache.size > 1000) {
      const oldestAllowed = now - DISPLAY_NAME_CACHE_DURATION;
      for (const [key, value] of displayNameCache.entries()) {
        if (value.lastFetchTime < oldestAllowed) {
          displayNameCache.delete(key);
        }
      }
    }

    return displayName;
  } catch (error) {
    console.error("Error getting display name:", error);
    return msg.author.username;
  }
}

export function shouldPrependSpeaker(): boolean {
  const value = (process.env.CONTENT_PREPEND_SPEAKER ?? "yes").trim().toLowerCase();
  if (["yes", "true", "1"].includes(value)) return true;
  if (["no", "false", "0"].includes(value)) return false;
  throw new Error("CONTENT_PREPEND_SPEAKER must be yes/no, true/false, or 1/0");
}

/** Format the cache for the requesting bot, oldest message first. */
async function formatConversation(
  messages: Message[],
  botId: string
): Promise<ConversationMessage[]> {
  const prependSpeaker = shouldPrependSpeaker();
  return Promise.all(messages.map(async (msg) => {
    const username = msg.author.id === botId ? "{{ai}}" : await getUserDisplayName(msg);
    return {
      username,
      text: prependSpeaker ? `[${username}]: ${msg.content}` : msg.content,
      timestamp: msg.createdAt.toISOString(),
    };
  }));
}

// Snowflakes provide a stable order even when messages share a timestamp.
function newestFirst(a: Message, b: Message): number {
  return BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0;
}

async function updateConversation(
  channel: TextChannel | DMChannel,
  contextSize: number,
  fetchBatch: number,
  cacheKey: string,
  botId: string
): Promise<ConversationMessage[]> {
  const existing = channelCache.get(cacheKey);
  const cached = existing?.contextSize === contextSize ? existing : undefined;
  // Work on a copy so a failed page does not leave a partially updated cache.
  const messages = new Map(cached?.messages);
  const fetchedIds = new Set<string>();
  const logPrefix = `[History bot=${botId} channel=${channel.id}]`;
  let pages = 0;
  let fetchedCount = 0;
  let before: string | undefined;

  while (fetchedIds.size < contextSize) {
    const limit = cached ? Math.min(10, fetchBatch) : Math.min(fetchBatch, contextSize - fetchedIds.size);
    const fetched = await channel.messages.fetch({ limit, before, cache: false });
    const page = Array.from(fetched.values()).sort(newestFirst);
    pages++;
    fetchedCount += page.length;
    console.log(
      `${logPrefix} fetch page=${pages} requested=${limit} received=${page.length}`
    );
    if (page.length === 0) break;

    const overlaps = page.some((msg) => cached?.messages.has(msg.id));
    for (const msg of page) {
      messages.set(msg.id, msg);
      fetchedIds.add(msg.id);
    }
    const oldestId = page[page.length - 1].id;
    if (before && BigInt(oldestId) >= BigInt(before)) {
      throw new Error("Discord message pagination did not advance");
    }
    // Once a whole context of newer messages is collected, older history
    // cannot affect the result, even if the previous cache is far behind.
    if (overlaps || page.length < limit || fetchedIds.size >= contextSize) break;
    before = oldestId;
  }

  const retained = Array.from(messages.values()).sort(newestFirst).slice(0, 1000);
  const conversation = await formatConversation(retained.slice(0, contextSize).reverse(), botId);
  channelCache.delete(cacheKey);
  channelCache.set(cacheKey, {
    contextSize,
    messages: new Map(retained.map((msg) => [msg.id, msg])),
  });
  const newCount = Array.from(fetchedIds).filter((id) => !cached?.messages.has(id)).length;
  console.log(
    `${logPrefix} refreshed mode=${cached ? "incremental" : "initial"}` +
    ` pages=${pages} fetched=${fetchedCount} new=${newCount}` +
    ` cached_before=${cached?.messages.size ?? 0} cached_after=${retained.length}` +
    ` trimmed=${messages.size - retained.length} context=${conversation.length}`
  );
  // Bound inactive channel caches; evicted channels refill on their next use.
  if (channelCache.size > 1000) {
    const oldestKey = channelCache.keys().next().value;
    if (oldestKey !== undefined) channelCache.delete(oldestKey);
  }
  return conversation;
}

/** Refresh history on every call, serializing updates for the same bot/channel. */
async function ephemeralFetchConversation(
  channel: TextChannel | DMChannel,
  contextSize: number = 200,
  fetchBatch: number = 100
): Promise<ConversationMessage[]> {
  if (!Number.isInteger(contextSize) || contextSize < 1 || contextSize > 1000) {
    throw new Error("KINDROID_MESSAGE_CONTEXT must be an integer between 1 and 1000");
  }
  if (!Number.isInteger(fetchBatch) || fetchBatch < 1 || fetchBatch > 100) {
    throw new Error("DISCORD_FETCH_BATCH must be an integer between 1 and 100");
  }
  const botId = channel.client.user?.id;
  if (!botId) throw new Error("Bot client ID not found");
  const cacheKey = `${botId}:${channel.id}`;
  const previous = pendingFetches.get(cacheKey);
  const current = (previous ?? Promise.resolve()).catch(() => undefined).then(
    () => updateConversation(channel, contextSize, fetchBatch, cacheKey, botId)
  );
  pendingFetches.set(cacheKey, current);
  try {
    return await current;
  } finally {
    if (pendingFetches.get(cacheKey) === current) pendingFetches.delete(cacheKey);
  }
}

export { ephemeralFetchConversation };
