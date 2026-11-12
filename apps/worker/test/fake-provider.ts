import { Readable } from 'node:stream';
import {
  CursorExpiredError,
  type AttachmentInfo,
  type ChangeBatch,
  type GetChangesOptions,
  type MailEnvelope,
  type MailFolderInfo,
  type MailProvider,
  type MailRef,
  type SearchPage,
  type SearchQuery,
} from '@mailvault/core';
import { GraphError } from '@mailvault/m365';

export interface FakeMessage extends MailEnvelope {
  body?: string;
  attachments: (AttachmentInfo & { content?: string | Buffer })[];
}

/** In-memory mailbox that behaves like Graph delta sync. */
export class FakeProvider implements MailProvider {
  readonly type = 'm365' as const;
  messages: FakeMessage[] = [];
  calls = { getChanges: 0, listAttachments: 0, openAttachment: 0, getBodyText: 0 };
  failNextOpen: Error[] = [];
  expireCursorOnce = false;
  private seq = 0;
  private added = new Map<string, number>(); // messageId -> seq when added

  add(m: Omit<FakeMessage, 'folderId' | 'providerMessageId' | 'hasAttachments' | 'cc' | 'to'> & Partial<FakeMessage>) {
    const id = m.providerMessageId ?? `msg-${this.seq + 1}`;
    const full: FakeMessage = {
      folderId: 'inbox',
      to: [{ email: 'accounts@test.local' }],
      cc: [],
      hasAttachments: (m.attachments?.length ?? 0) > 0,
      ...m,
      providerMessageId: id,
    };
    this.messages.push(full);
    this.added.set(id, ++this.seq);
    return full;
  }

  async testConnection(mailbox: string) {
    return { ok: true, latencyMs: 1, mailbox };
  }

  async listFolders(): Promise<MailFolderInfo[]> {
    return [{ id: 'inbox', displayName: 'Inbox', path: 'Inbox' }];
  }

  async getChanges(o: GetChangesOptions): Promise<ChangeBatch> {
    this.calls.getChanges++;
    if (o.cursor && this.expireCursorOnce) {
      this.expireCursorOnce = false;
      throw new CursorExpiredError();
    }
    const since = o.cursor ? Number(o.cursor.split(':')[1]) : 0;
    const messages = this.messages.filter(
      (m) => m.folderId === o.folderId && (this.added.get(m.providerMessageId) ?? 0) > since && (o.cursor || m.receivedAt >= o.receivedAfter),
    );
    return { messages, cursor: `seq:${this.seq}` };
  }

  calls2 = { search: 0 };

  async search(q: SearchQuery): Promise<SearchPage> {
    this.calls2.search++;
    const all = this.messages
      .filter((m) => m.folderId === q.folderId && m.receivedAt >= q.receivedFrom && m.receivedAt <= q.receivedTo && (!q.onlyWithAttachments || m.hasAttachments))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const size = q.pageSize ?? 50;
    const start = q.pageCursor ? Number(q.pageCursor) : 0;
    const messages = all.slice(start, start + size);
    return { messages, nextCursor: start + size < all.length ? String(start + size) : null };
  }

  async getMessage(ref: MailRef) {
    return this.find(ref.messageId);
  }

  async getBodyText(ref: MailRef) {
    this.calls.getBodyText++;
    return this.find(ref.messageId).body ?? '';
  }

  async listAttachments(ref: MailRef) {
    this.calls.listAttachments++;
    return this.find(ref.messageId).attachments.map(({ content: _c, ...a }) => a);
  }

  async openAttachment(ref: MailRef, attachmentId: string) {
    this.calls.openAttachment++;
    const next = this.failNextOpen.shift();
    if (next) throw next;
    const a = this.find(ref.messageId).attachments.find((x) => x.id === attachmentId);
    if (!a) throw new GraphError('Not found', 404, 'ErrorItemNotFound');
    return Readable.from([Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? `content of ${a.name}`)]);
  }

  private find(id: string) {
    const m = this.messages.find((x) => x.providerMessageId === id);
    if (!m) throw new GraphError('Not found', 404, 'ErrorItemNotFound');
    return m;
  }
}
