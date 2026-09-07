import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { loadConfig } from './accounts.js';
import { authorizeAccount } from './auth.js';
import { gmailFor, callGmail, type AccountContext } from './gmail.js';
import { shapeMessage, shapeThread, shapeThreadSummary, header } from './shape.js';

const PREFIX = 'Multi-account Gmail (all connected accounts). ';
const account = z
  .string()
  .describe('Which Gmail account to use: an alias (e.g. "personal", "work") or the email address. See list_accounts.');

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 1) }],
});
const fail = (e: unknown): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
});

function safeDownloadFilename(input: string): string {
  const basename = path.basename(input);
  const cleaned = basename.replace(/[^A-Za-z0-9._()\- ]/g, '_').replace(/^\.+/, '').trim();
  const compact = cleaned.replace(/\s+/g, ' ').replace(/^-+/, '');
  const noTrailingDots = compact.replace(/[. ]+$/g, '');
  return (noTrailingDots || 'attachment').slice(0, 180);
}

function register(
  server: McpServer,
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  handler: (args: any) => Promise<unknown>
): void {
  server.registerTool(name, { description, inputSchema }, async (args: any) => {
    try {
      return ok(await handler(args));
    } catch (e) {
      console.error(`gmail-multi ${name}:`, e instanceof Error ? e.message : e);
      return fail(e);
    }
  });
}

// ---------------------------------------------------------------------------
// Compose helpers
// ---------------------------------------------------------------------------

interface ComposeArgs {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  replyToMessageId?: string;
}

const composeShape = {
  to: z.array(z.string()).optional().describe('Recipient email addresses. Optional when replying — defaults to the original sender.'),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional().describe('Optional when replying — defaults to "Re: <original subject>".'),
  body: z.string().describe('Plain-text message body.'),
  replyToMessageId: z
    .string()
    .optional()
    .describe('Gmail message ID being replied to. Sets correct threading headers (In-Reply-To/References) and threadId automatically.'),
};

async function buildMime(ctx: AccountContext, args: ComposeArgs): Promise<{ raw: string; threadId?: string }> {
  let { to, cc, bcc, subject } = args;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  let threadId: string | undefined;

  if (args.replyToMessageId) {
    const orig = await callGmail(ctx, 'fetch reply target', () =>
      ctx.gmail.users.messages.get({
        userId: 'me',
        id: args.replyToMessageId!,
        format: 'metadata',
        metadataHeaders: ['Message-ID', 'References', 'Subject', 'From', 'Reply-To'],
      })
    );
    threadId = orig.data.threadId ?? undefined;
    const origMsgId = header(orig.data.payload, 'Message-ID');
    if (origMsgId) {
      inReplyTo = origMsgId;
      references = [header(orig.data.payload, 'References'), origMsgId].filter(Boolean).join(' ');
    }
    if (!subject) {
      const s = header(orig.data.payload, 'Subject');
      subject = /^re:/i.test(s) ? s : `Re: ${s}`;
    }
    if (!to || to.length === 0) {
      to = [header(orig.data.payload, 'Reply-To') || header(orig.data.payload, 'From')];
    }
  }
  if (!to || to.length === 0) throw new Error('"to" is required unless replyToMessageId is provided.');

  const mail = new MailComposer({ to, cc, bcc, subject, text: args.body, inReplyTo, references });
  const buf = await new Promise<Buffer>((resolve, reject) =>
    mail.compile().build((err, message) => (err ? reject(err) : resolve(message)))
  );
  return { raw: buf.toString('base64url'), threadId };
}

// ---------------------------------------------------------------------------
// Label name/ID resolution (per-account cache, refreshed on miss)
// ---------------------------------------------------------------------------

const labelCache = new Map<string, Map<string, string>>(); // alias -> lowercased name -> id

async function labelMap(ctx: AccountContext, refresh = false): Promise<Map<string, string>> {
  if (!refresh) {
    const cached = labelCache.get(ctx.alias);
    if (cached) return cached;
  }
  const res = await callGmail(ctx, 'list labels', () => ctx.gmail.users.labels.list({ userId: 'me' }));
  const map = new Map<string, string>();
  for (const l of res.data.labels ?? []) {
    if (l.name && l.id) map.set(l.name.toLowerCase(), l.id);
  }
  labelCache.set(ctx.alias, map);
  return map;
}

async function resolveLabelIds(ctx: AccountContext, labels: string[]): Promise<string[]> {
  let map = await labelMap(ctx);
  const ids: string[] = [];
  for (const label of labels) {
    if ([...map.values()].includes(label)) {
      ids.push(label); // already an ID
      continue;
    }
    let id = map.get(label.toLowerCase());
    if (!id) {
      map = await labelMap(ctx, true);
      id = map.get(label.toLowerCase());
    }
    if (!id) {
      throw new Error(`No label "${label}" in ${ctx.email}. Labels: ${[...map.keys()].sort().join(', ')}`);
    }
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerTools(server: McpServer): void {
  // --- Accounts ---

  register(
    server,
    'list_accounts',
    PREFIX + 'List the connected Gmail accounts (alias + email). Call this when unsure which accounts exist or what to pass as "account".',
    {},
    async () => {
      const config = loadConfig();
      return Object.entries(config.accounts).map(([alias, a]) => ({
        alias,
        email: a.email,
        isDefault: config.defaultAccount === alias,
      }));
    }
  );

  register(
    server,
    'add_account',
    PREFIX +
      'Connect a new Gmail account via OAuth: opens a browser for authorization and stores the token locally. ' +
      'If this times out before the user finishes, run instead in a terminal: npm run auth -- --alias <alias> (in the gmail-mcp project).',
    {
      alias: z.string().describe('Short friendly name for the account, e.g. "personal" or "work".'),
      email: z.string().optional().describe('Expected email address — aborts if a different account is authorized.'),
    },
    async (args) => {
      const result = await authorizeAccount(args.alias, args.email);
      return `Account "${result.alias}" (${result.email}) connected and ready.`;
    }
  );

  // --- Read / search ---

  register(
    server,
    'search_threads',
    PREFIX +
      'Search email threads in one account using full Gmail search syntax ' +
      '(e.g. "from:alice is:unread newer_than:7d has:attachment subject:invoice"). Returns compact thread summaries.',
    {
      account,
      query: z.string().describe('Gmail search query.'),
      maxResults: z.number().int().min(1).max(25).optional().describe('Default 10, max 25.'),
      pageToken: z.string().optional().describe('From a previous result, for pagination.'),
      labelIds: z.array(z.string()).optional().describe('Restrict to these label IDs (e.g. ["INBOX"]).'),
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'search threads', () =>
        ctx.gmail.users.threads.list({
          userId: 'me',
          q: args.query,
          maxResults: args.maxResults ?? 10,
          pageToken: args.pageToken,
          labelIds: args.labelIds,
        })
      );
      const threads = res.data.threads ?? [];
      const detailed = await Promise.all(
        threads.map((t) =>
          callGmail(ctx, 'get thread summary', () =>
            ctx.gmail.users.threads.get({
              userId: 'me',
              id: t.id!,
              format: 'metadata',
              metadataHeaders: ['Subject', 'From', 'Date'],
            })
          )
        )
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        resultSizeEstimate: res.data.resultSizeEstimate,
        ...(res.data.nextPageToken ? { nextPageToken: res.data.nextPageToken } : {}),
        threads: detailed.map((d) =>
          shapeThreadSummary(d.data, threads.find((t) => t.id === d.data.id)?.snippet)
        ),
      };
    }
  );

  register(
    server,
    'get_thread',
    PREFIX + 'Read a full email thread (all messages, bodies, attachment metadata).',
    {
      account,
      threadId: z.string(),
      includeFullBodies: z.boolean().optional().describe('Default true. Set false for a quick skim (300-char bodies).'),
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'get thread', () =>
        ctx.gmail.users.threads.get({ userId: 'me', id: args.threadId, format: 'full' })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        threadId: args.threadId,
        messages: shapeThread(res.data, args.includeFullBodies ?? true),
      };
    }
  );

  register(
    server,
    'get_message',
    PREFIX + 'Read a single email message in full (untruncated up to ~20k chars).',
    { account, messageId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'get message', () =>
        ctx.gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' })
      );
      return { account: ctx.alias, email: ctx.email, ...shapeMessage(res.data, 20000) };
    }
  );

  register(
    server,
    'download_attachment',
    PREFIX + 'Download an email attachment to ~/Downloads. Get attachmentId from get_thread/get_message.',
    {
      account,
      messageId: z.string(),
      attachmentId: z.string(),
      filename: z.string().optional().describe('Filename to save as (from the attachment metadata).'),
    },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'download attachment', () =>
        ctx.gmail.users.messages.attachments.get({
          userId: 'me',
          messageId: args.messageId,
          id: args.attachmentId,
        })
      );
      if (!res.data.data) throw new Error('Attachment has no data.');
      const safe = safeDownloadFilename(args.filename ?? `attachment-${args.attachmentId.slice(0, 12)}`);
      let target = path.join(os.homedir(), 'Downloads', safe);
      const { name, ext } = path.parse(target);
      for (let i = 1; fs.existsSync(target); i++) target = path.join(os.homedir(), 'Downloads', `${name}-${i}${ext}`);
      fs.writeFileSync(target, Buffer.from(res.data.data, 'base64url'));
      return `Saved to ${target} (${res.data.size ?? 'unknown'} bytes).`;
    }
  );

  // --- Compose / send ---

  register(
    server,
    'create_draft',
    PREFIX + 'Create a draft email (does NOT send). Supports replies via replyToMessageId.',
    { account, ...composeShape },
    async (args) => {
      const ctx = gmailFor(args.account);
      const { raw, threadId } = await buildMime(ctx, args);
      const res = await callGmail(ctx, 'create draft', () =>
        ctx.gmail.users.drafts.create({ userId: 'me', requestBody: { message: { raw, threadId } } })
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        draftId: res.data.id,
        messageId: res.data.message?.id,
        note: 'Draft created — visible in Gmail. Use send_draft to send it.',
      };
    }
  );

  register(
    server,
    'list_drafts',
    PREFIX + 'List saved drafts with their subjects and recipients.',
    { account, maxResults: z.number().int().min(1).max(25).optional().describe('Default 10.') },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'list drafts', () =>
        ctx.gmail.users.drafts.list({ userId: 'me', maxResults: args.maxResults ?? 10 })
      );
      const drafts = res.data.drafts ?? [];
      const detailed = await Promise.all(
        drafts.map((d) =>
          callGmail(ctx, 'get draft', () =>
            ctx.gmail.users.drafts.get({ userId: 'me', id: d.id!, format: 'metadata' })
          )
        )
      );
      return {
        account: ctx.alias,
        email: ctx.email,
        drafts: detailed.map((d) => ({
          draftId: d.data.id,
          messageId: d.data.message?.id,
          to: header(d.data.message?.payload, 'To'),
          subject: header(d.data.message?.payload, 'Subject'),
          threadId: d.data.message?.threadId,
        })),
      };
    }
  );

  register(
    server,
    'delete_draft',
    PREFIX + 'Delete a draft permanently (use this to discard a draft the user rejected). Does not affect sent mail.',
    { account, draftId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'delete draft', () => ctx.gmail.users.drafts.delete({ userId: 'me', id: args.draftId }));
      return `Draft ${args.draftId} deleted in ${ctx.email}.`;
    }
  );

  register(
    server,
    'send_draft',
    PREFIX + 'Send an existing draft. Sends immediately as the account\'s email address — only after the user approved it.',
    { account, draftId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'send draft', () =>
        ctx.gmail.users.drafts.send({ userId: 'me', requestBody: { id: args.draftId } })
      );
      return { account: ctx.alias, email: ctx.email, sent: true, messageId: res.data.id, threadId: res.data.threadId };
    }
  );

  register(
    server,
    'send_message',
    PREFIX +
      'Send an email immediately as the account\'s email address. Prefer create_draft unless the user has explicitly approved sending. Supports replies via replyToMessageId.',
    { account, ...composeShape },
    async (args) => {
      const ctx = gmailFor(args.account);
      const { raw, threadId } = await buildMime(ctx, args);
      const res = await callGmail(ctx, 'send message', () =>
        ctx.gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } })
      );
      return { account: ctx.alias, email: ctx.email, sent: true, messageId: res.data.id, threadId: res.data.threadId };
    }
  );

  // --- Labels ---

  register(
    server,
    'list_labels',
    PREFIX + 'List all labels in one account (system + user labels).',
    { account },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'list labels', () => ctx.gmail.users.labels.list({ userId: 'me' }));
      labelCache.delete(ctx.alias); // listing is the freshest source; let the cache rebuild
      return {
        account: ctx.alias,
        email: ctx.email,
        labels: (res.data.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type })),
      };
    }
  );

  register(server, 'create_label', PREFIX + 'Create a new label.', { account, name: z.string() }, async (args) => {
    const ctx = gmailFor(args.account);
    const res = await callGmail(ctx, 'create label', () =>
      ctx.gmail.users.labels.create({ userId: 'me', requestBody: { name: args.name } })
    );
    labelCache.delete(ctx.alias);
    return { account: ctx.alias, labelId: res.data.id, name: res.data.name };
  });

  register(
    server,
    'update_label',
    PREFIX + 'Rename a label.',
    { account, labelId: z.string(), name: z.string().describe('New name.') },
    async (args) => {
      const ctx = gmailFor(args.account);
      const res = await callGmail(ctx, 'update label', () =>
        ctx.gmail.users.labels.patch({ userId: 'me', id: args.labelId, requestBody: { name: args.name } })
      );
      labelCache.delete(ctx.alias);
      return { account: ctx.alias, labelId: res.data.id, name: res.data.name };
    }
  );

  register(
    server,
    'delete_label',
    PREFIX + 'Delete a label (does not delete the emails carrying it).',
    { account, labelId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'delete label', () => ctx.gmail.users.labels.delete({ userId: 'me', id: args.labelId }));
      labelCache.delete(ctx.alias);
      return `Label ${args.labelId} deleted in ${ctx.email}.`;
    }
  );

  const labelsParam = z.array(z.string()).describe('Label names or IDs.');

  const modifyTool = (
    name: string,
    description: string,
    idField: 'threadId' | 'messageId',
    apply: (ctx: AccountContext, id: string, labelIds: string[]) => Promise<unknown>
  ) => {
    register(
      server,
      name,
      PREFIX + description,
      { account, [idField]: z.string(), labels: labelsParam },
      async (args) => {
        const ctx = gmailFor(args.account);
        const labelIds = await resolveLabelIds(ctx, args.labels);
        await apply(ctx, args[idField], labelIds);
        return `Done: ${name} [${args.labels.join(', ')}] on ${idField} ${args[idField]} in ${ctx.email}.`;
      }
    );
  };

  modifyTool('label_thread', 'Add labels to a thread.', 'threadId', (ctx, id, addLabelIds) =>
    callGmail(ctx, 'label thread', () =>
      ctx.gmail.users.threads.modify({ userId: 'me', id, requestBody: { addLabelIds } })
    )
  );
  modifyTool('unlabel_thread', 'Remove labels from a thread.', 'threadId', (ctx, id, removeLabelIds) =>
    callGmail(ctx, 'unlabel thread', () =>
      ctx.gmail.users.threads.modify({ userId: 'me', id, requestBody: { removeLabelIds } })
    )
  );
  modifyTool('label_message', 'Add labels to a single message.', 'messageId', (ctx, id, addLabelIds) =>
    callGmail(ctx, 'label message', () =>
      ctx.gmail.users.messages.modify({ userId: 'me', id, requestBody: { addLabelIds } })
    )
  );
  modifyTool('unlabel_message', 'Remove labels from a single message.', 'messageId', (ctx, id, removeLabelIds) =>
    callGmail(ctx, 'unlabel message', () =>
      ctx.gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds } })
    )
  );

  // --- Archive / trash ---

  register(
    server,
    'archive_thread',
    PREFIX + 'Archive a thread (remove it from the inbox; it stays searchable in All Mail).',
    { account, threadId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'archive thread', () =>
        ctx.gmail.users.threads.modify({ userId: 'me', id: args.threadId, requestBody: { removeLabelIds: ['INBOX'] } })
      );
      return `Thread ${args.threadId} archived in ${ctx.email}.`;
    }
  );

  register(
    server,
    'trash_thread',
    PREFIX + 'Move a whole thread to Trash (recoverable for 30 days).',
    { account, threadId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'trash thread', () => ctx.gmail.users.threads.trash({ userId: 'me', id: args.threadId }));
      return `Thread ${args.threadId} moved to Trash in ${ctx.email} (recoverable for 30 days).`;
    }
  );

  register(
    server,
    'trash_message',
    PREFIX + 'Move a single message to Trash (recoverable for 30 days).',
    { account, messageId: z.string() },
    async (args) => {
      const ctx = gmailFor(args.account);
      await callGmail(ctx, 'trash message', () => ctx.gmail.users.messages.trash({ userId: 'me', id: args.messageId }));
      return `Message ${args.messageId} moved to Trash in ${ctx.email} (recoverable for 30 days).`;
    }
  );
}
