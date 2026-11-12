import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  AttachmentInfo,
  AttachmentKind,
  ConnectionTestResult,
  MailProvider,
  MailRef,
} from '@mailvault/core';
import { GraphClient, GraphError, type GraphConfig } from './graph-client.js';

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
