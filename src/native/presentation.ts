export interface Presentation {
  messageId: boolean;
  date: boolean;
  time: boolean;
  roomLabel: boolean;
  roomId: boolean;
}
export const defaultPresentation: Presentation = {
  messageId: false,
  date: false,
  time: true,
  roomLabel: false,
  roomId: false,
};
export function loadPresentation(
  env: Record<string, string | undefined>,
): Presentation {
  const result = { ...defaultPresentation };
  const names: Record<keyof Presentation, string> = {
    messageId: 'CONTENT_PREPEND_MESSAGE_ID',
    date: 'CONTENT_PREPEND_DATE',
    time: 'CONTENT_PREPEND_TIME',
    roomLabel: 'CONTENT_PREPEND_ROOM_LABEL',
    roomId: 'CONTENT_PREPEND_ROOM_ID',
  };
  for (const key of Object.keys(names) as (keyof Presentation)[]) {
    const value = env[names[key]]?.trim().toLowerCase();
    if (value === undefined) continue;
    if (value !== 'yes' && value !== 'no')
      throw new Error(`${names[key]} must be yes or no`);
    result[key] = value === 'yes';
  }
  return result;
}
