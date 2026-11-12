import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  CursorExpiredError,
  type AttachmentInfo,
  type AttachmentKind,
  type ChangeBatch,
  type ConnectionTestResult,
  type GetChangesOptions,
  type MailAddress,
  type MailEnvelope,
  type MailFolderInfo,
  type MailProvider,
  type MailRef,
} from '@mailvault/core';
import { GraphClient, GraphError, type GraphConfig } from './graph-client.js';

interface GraphRecipient {
  emailAddress?: { address?: string; name?: string };
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  hasAttachments?: boolean;
  parentFolderId?: string;
  '@removed'?: unknown;
}

interface GraphFolder {
  id: string;
  displayName: string;
  totalItemCount?: number;
  childFolderCount?: number;
}

const MESSAGE_FIELDS = 'id,internetMessageId,subject,from,sender,toRecipients,ccRecipients,receivedDateTime,hasAttachments,parentFolderId';

const addr = (r?: GraphRecipient): MailAddress => ({
  email: (r?.emailAddress?.address ?? '').toLowerCase(),
  name: r?.emailAddress?.name,
});

interface GraphAttachment {
  '@odata.type': string;
  id: string;
  name: string;
  contentType?: string;
  size: number;
  isInline: boolean;
}

const kindOf = (odataType: string): AttachmentKind =>
  odataType.endsWith('fileAttachment')
    ? 'file'
    : odataType.endsWith('itemAttachment')
      ? 'item'
      : odataType.endsWith('referenceAttachment')
        ? 'reference'
        : 'unknown';

const enc = encodeURIComponent;

export class M365Provider implements MailProvider {
  readonly type = 'm365' as const;
  readonly graph: GraphClient;

  constructor(cfg: GraphConfig) {
    this.graph = new GraphClient(cfg);
  }

  /** Token → mailbox folders → newest message. Read-only calls only. */
  async testConnection(mailbox: string): Promise<ConnectionTestResult> {
    const started = Date.now();
    try {
      const folders = await this.graph.json<{ value: { displayName: string }[] }>(
        `/users/${enc(mailbox)}/mailFolders?$top=100&$select=displayName`,
      );
      const latest = await this.graph.json<{ value: { subject?: string }[] }>(
        `/users/${enc(mailbox)}/mailFolders/inbox/messages?$top=1&$select=subject,receivedDateTime&$orderby=receivedDateTime desc`,
      );
      return {
        ok: true,
        latencyMs: Date.now() - started,
        mailbox,
        folderCount: folders.value.length,
        sampleMessageSubject: latest.value[0]?.subject ?? '(inbox is empty)',
      };
    } catch (err) {
      const e = err as GraphError;
      return { ok: false, latencyMs: Date.now() - started, mailbox, error: explainGraphError(e) };
    }
  }

  /** All mail folders with their full path (Inbox, Inbox/Vendors, …). */
  async listFolders(mailbox: string): Promise<MailFolderInfo[]> {
    const out: MailFolderInfo[] = [];
    const walk = async (url: string, parentPath: string, depth: number) => {
      let next: string | undefined = url;
      while (next) {
        const page: { value: GraphFolder[]; '@odata.nextLink'?: string } = await this.graph.json(next);
        for (const f of page.value) {
          const path = parentPath ? `${parentPath}/${f.displayName}` : f.displayName;
          out.push({ id: f.id, displayName: f.displayName, path, totalItemCount: f.totalItemCount });
          if (f.childFolderCount && depth < 4) {
            await walk(`/users/${enc(mailbox)}/mailFolders/${enc(f.id)}/childFolders?$top=100&$select=id,displayName,totalItemCount,childFolderCount`, path, depth + 1);
          }
        }
        next = page['@odata.nextLink'];
      }
    };
    await walk(`/users/${enc(mailbox)}/mailFolders?$top=100&$select=id,displayName,totalItemCount,childFolderCount`, '', 0);
    return out;
  }

  /**
   * Delta sync for one folder. First call (no cursor) only returns mail received after `receivedAfter`.
   * Returns new messages and the deltaLink to store; removed/updated-only items are ignored.
   */
  async getChanges(o: GetChangesOptions): Promise<ChangeBatch> {
    let url: string | undefined =
      o.cursor ??
      `/users/${enc(o.mailbox)}/mailFolders/${enc(o.folderId)}/messages/delta?$select=${MESSAGE_FIELDS}` +
        `&$filter=receivedDateTime ge ${o.receivedAfter.toISOString()}`;
    const messages: MailEnvelope[] = [];
    let cursor = '';
    try {
      while (url) {
        const page: { value: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string } = await this.graph.json(url, {
          prefer: ['odata.maxpagesize=50'],
        });
        for (const m of page.value) {
          if (m['@removed'] || !m.receivedDateTime) continue;
          messages.push(toEnvelope(m, o.folderId));
        }
        url = page['@odata.nextLink'];
        if (page['@odata.deltaLink']) cursor = page['@odata.deltaLink'];
      }
    } catch (err) {
      const e = err as GraphError;
      if (o.cursor && (e.status === 410 || /syncState|SyncStateNotFound|InvalidSyncState/i.test(e.code ?? ''))) throw new CursorExpiredError();
      throw err;
    }
    return { messages, cursor };
  }

  async getBodyText(ref: MailRef): Promise<string> {
    const m = await this.graph.json<{ body?: { content?: string } }>(
      `/users/${enc(ref.mailbox)}/messages/${enc(ref.messageId)}?$select=body`,
      { prefer: ['outlook.body-content-type="text"'] },
    );
    return m.body?.content ?? '';
  }

  async listAttachments(ref: MailRef): Promise<AttachmentInfo[]> {
    const res = await this.graph.json<{ value: GraphAttachment[] }>(
      `/users/${enc(ref.mailbox)}/messages/${enc(ref.messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    );
    return res.value.map((a) => ({
      id: a.id,
      name: a.name,
      contentType: a.contentType,
      size: a.size,
      isInline: a.isInline,
      kind: kindOf(a['@odata.type']),
    }));
  }

  /** Raw attachment bytes as a Node stream (never buffered in memory). */
  async openAttachment(ref: MailRef, attachmentId: string): Promise<NodeJS.ReadableStream> {
    const res = await this.graph.request(
      `/users/${enc(ref.mailbox)}/messages/${enc(ref.messageId)}/attachments/${enc(attachmentId)}/$value`,
    );
    if (!res.body) throw new GraphError('Empty attachment body', 500);
    return Readable.fromWeb(res.body as unknown as WebReadableStream);
  }
}

function toEnvelope(m: GraphMessage, folderId: string): MailEnvelope {
  return {
    providerMessageId: m.id,
    internetMessageId: m.internetMessageId,
    folderId: m.parentFolderId ?? folderId,
    from: addr(m.from ?? m.sender),
    to: (m.toRecipients ?? []).map(addr),
    cc: (m.ccRecipients ?? []).map(addr),
    subject: m.subject ?? '',
    receivedAt: new Date(m.receivedDateTime!),
    hasAttachments: m.hasAttachments ?? false,
  };
}

/** Turns Graph errors into messages an admin can act on. */
export function explainGraphError(e: GraphError | Error): string {
  if (!(e instanceof GraphError)) return e.message;
  if (e.status === 401) return 'Authentication failed: check tenant ID, client ID and certificate/secret.';
  if (e.status === 403 || e.code === 'ErrorAccessDenied')
    return 'Access denied: the app has no Mail.Read permission for this mailbox (check Exchange RBAC scope / admin consent).';
  if (e.status === 404 || e.code === 'ResourceNotFound' || e.code === 'MailboxNotEnabledForRESTAPI')
    return 'Mailbox not found or not enabled for Graph (check the address and that it is an Exchange Online mailbox).';
  if (e.status === 429) return 'Microsoft is throttling requests. Try again in a few minutes.';
  return `${e.message}${e.code ? ` (${e.code})` : ''}`;
}
