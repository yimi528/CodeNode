import type { SessionMsg } from '../types';

const greeting = /^(?:你好|您好|嗨|hello|hi)[。！!\s]*$/i;

export function firstTitleMessage(messages?: SessionMsg[]): SessionMsg | undefined {
  const userMessages = messages?.filter(message => message.role === 'user' && !message.compaction);
  return userMessages?.find(message => message.attachments?.length || (message.content.trim() && !greeting.test(message.content.trim())))
    || userMessages?.[0];
}

export function conversationTitle(label?: string, message?: Pick<SessionMsg, 'content' | 'attachments'>): string {
  const current = label?.trim() || '未命名对话';
  if (!message || (!/^(?:画布\s*\d*|未命名对话)$/.test(current) && !greeting.test(current))) return current;

  const opening = message.content.trim()
    .replace(/^(?:你好|您好|嗨|hello|hi)(?:[，、,。！!：:\s]+|$)/i, '')
    .replace(/^(?:麻烦你|能不能|可以帮我|请帮我|帮我|请)\s*/, '');
  const topic = opening.split(/[。！？；!?;\r\n]/)
    .map(part => part.replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/, '').replace(/\*\*|`/g, '').trim())
    .find(Boolean);
  const text = topic || message.attachments?.[0]?.name || message.content.trim();
  const characters = Array.from(text.replace(/\s+/g, ' '));
  return characters.length > 30 ? characters.slice(0, 30).join('').trimEnd() + '…'
    : characters.join('') || current;
}
