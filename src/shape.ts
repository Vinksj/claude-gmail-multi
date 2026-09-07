import type { gmail_v1 } from 'googleapis';

export const MAX_BODY_CHARS = 4000;
export const MAX_THREAD_CHARS = 25000;
/** HTML bodies are verbose; cap them well below the plain-text allowance. */
export const MAX_HTML_CHARS = 20000;

export interface AttachmentShape {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  attachmentId: string;
}

export interface MessageShape {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  date: string;
  subject: string;
  labels: string[];
  body: string;
  /** Raw text/html part. Only populated when the caller opts in — see get_message's includeHtml. */
  htmlBody?: string;
  attachments: AttachmentShape[];
}

export function header(payload: gmail_v1.Schema$MessagePart | null | undefined, name: string): string {
  return payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';
}

function decodeB64(data?: string | null): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

export function extractBody(payload?: gmail_v1.Schema$MessagePart | null): {
  text: string;
  html: string;
  attachments: AttachmentShape[];
} {
  const plains: string[] = [];
  const htmls: string[] = [];
  const attachments: AttachmentShape[] = [];
  const walk = (part?: gmail_v1.Schema$MessagePart | null) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        filename: part.filename,
        mimeType: part.mimeType ?? '',
        sizeBytes: part.body.size ?? 0,
        attachmentId: part.body.attachmentId,
      });
    } else if (part.mimeType === 'text/plain' && part.body?.data) {
      plains.push(decodeB64(part.body.data));
    } else if (part.mimeType === 'text/html' && part.body?.data) {
      htmls.push(decodeB64(part.body.data));
    }
    part.parts?.forEach(walk);
  };
  walk(payload);
  const html = htmls.join('\n');
  const text = plains.length > 0 ? plains.join('\n') : stripHtml(html);
  return { text: text.trim(), html: html.trim(), attachments };
}

export function stripHtml(html: string): string {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<head[\s\S]*?<\/head>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  ).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

export function truncate(text: string, max: number, hint = 'use get_message for the full body'): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  const head = text.slice(0, cut > max / 2 ? cut : max);
  return `${head}\n[... truncated, ${text.length.toLocaleString('en-US')} chars total — ${hint}]`;
}

export function shapeMessage(
  msg: gmail_v1.Schema$Message,
  maxBody = MAX_BODY_CHARS,
  includeHtml = false
): MessageShape {
  const payload = msg.payload;
  const { text, html, attachments } = extractBody(payload);
  const cc = header(payload, 'Cc');
  return {
    id: msg.id ?? '',
    threadId: msg.threadId ?? '',
    from: header(payload, 'From'),
    to: header(payload, 'To'),
    ...(cc ? { cc } : {}),
    date: header(payload, 'Date'),
    subject: header(payload, 'Subject'),
    labels: msg.labelIds ?? [],
    body: truncate(text, maxBody),
    ...(includeHtml && html
      ? { htmlBody: truncate(html, MAX_HTML_CHARS, 'HTML body truncated') }
      : {}),
    attachments,
  };
}

export interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  messageCount: number;
  unread: boolean;
  labels: string[];
}

/** Compact summary from a threads.get(format: 'metadata') response. */
export function shapeThreadSummary(thread: gmail_v1.Schema$Thread, snippet?: string | null): ThreadSummary {
  const msgs = thread.messages ?? [];
  const first = msgs[0];
  const last = msgs[msgs.length - 1];
  return {
    id: thread.id ?? '',
    subject: header(first?.payload, 'Subject'),
    from: header(last?.payload, 'From'),
    date: header(last?.payload, 'Date'),
    snippet: decodeEntities(snippet ?? last?.snippet ?? ''),
    messageCount: msgs.length,
    unread: msgs.some((m) => m.labelIds?.includes('UNREAD')),
    labels: [...new Set(msgs.flatMap((m) => m.labelIds ?? []))],
  };
}

/**
 * Shape a full thread, capping total output at MAX_THREAD_CHARS. Newest messages keep
 * their bodies; older ones get omitted first.
 */
export function shapeThread(thread: gmail_v1.Schema$Thread, includeFullBodies = true): MessageShape[] {
  const msgs = (thread.messages ?? []).map((m) =>
    shapeMessage(m, includeFullBodies ? MAX_BODY_CHARS : 300)
  );
  let total = msgs.reduce((n, m) => n + m.body.length, 0);
  for (const m of msgs) {
    if (total <= MAX_THREAD_CHARS) break;
    if (m === msgs[msgs.length - 1]) break; // always keep the newest message intact
    total -= m.body.length;
    m.body = `[omitted to keep output compact — use get_message ${m.id} to read this one]`;
  }
  return msgs;
}
