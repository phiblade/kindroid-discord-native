import axios, { AxiosError } from 'axios';
import {
  ConversationMessage,
  KindroidResponse,
  KindroidAIResult,
} from './types';

/**
 * Calls the Kindroid AI inference endpoint
 * @param sharedAiCode - shared code for API identification
 * @param conversation - array of conversation messages
 * @param enableFilter - whether to enable NSFW filtering
 * @returns KindroidAIResult indicating success with reply or rate limit
 * @throws Error if the API call fails (except for rate limits)
 */
export async function callKindroidAI(
  sharedAiCode: string,
  conversation: ConversationMessage[],
  enableFilter: boolean = false,
  logContext?: { botId: string; channelId: string },
): Promise<KindroidAIResult> {
  try {
    if (conversation.length === 0) {
      throw new Error('Conversation array cannot be empty');
    }

    const lastUsername = conversation[conversation.length - 1].username;

    // Encode username to handle non-ASCII characters, then hash to alphanumeric
    const hashedUsername = Buffer.from(encodeURIComponent(lastUsername))
      .toString('base64')
      .replace(/[^a-zA-Z0-9]/g, '')
      .slice(0, 32); // Limit length to 32 chars

    const logPrefix = logContext
      ? `[Kindroid bot=${logContext.botId} channel=${logContext.channelId}]`
      : '[Kindroid]';
    console.log(`${logPrefix} sending messages=${conversation.length}`);
    const response = await axios.post<KindroidResponse>(
      process.env.KINDROID_INFER_URL!,
      {
        share_code: sharedAiCode,
        conversation,
        enable_filter: enableFilter,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.KINDROID_API_KEY!}`,
          'X-Kindroid-Requester': hashedUsername,
          'Content-Type': 'application/json',
        },
      },
    );

    if (!response.data.success) {
      throw new Error(response.data.error || 'API request failed');
    }

    console.log(`${logPrefix} succeeded messages=${conversation.length}`);

    return {
      type: 'success',
      reply: response.data.reply.replace(/@(everyone|here)/g, ''),
    };
  } catch (error) {
    console.error('Error calling Kindroid AI:', (error as Error).message);
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<KindroidResponse>;
      if (axiosError.response) {
        console.error('Response data:', axiosError.response.data);
        console.error('Response status:', axiosError.response.status);
        if (axiosError.response.status === 429) {
          return { type: 'rate_limited' };
        }
        if (axiosError.response.data?.error) {
          throw new Error(axiosError.response.data.error);
        }
      }
    }
    throw new Error('Failed to get response from Kindroid AI');
  }
}
