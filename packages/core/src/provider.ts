// Provider-neutral mail model. Microsoft 365 is implemented first; Gmail plugs in behind the same interface.

export type ProviderType = 'm365' | 'gmail';

export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailEnvelope {
  providerMessageId: string; // immutable ID for M365
  internetMessageId?: string;
  folderId: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  receivedAt: Date;
  hasAttachments: boolean;
}

export type AttachmentKind = 'file' | 'item' | 'reference' | 'unknown';

export interface AttachmentInfo {
  id: string;
  name: string;
  contentType?: string;
  size: number;
  isInline: boolean;
  kind: AttachmentKind;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  mailbox: string;
  displayName?: string;
  folderCount?: number;
  sampleMessageSubject?: string;
  error?: string;
}

export interface MailRef {
  mailbox: string;
  messageId: string;
}

export interface MailFolderInfo {
  id: string;
  displayName: string;
  path: string; // e.g. "Inbox/Vendors"
  totalItemCount?: number;
}

export interface ChangeBatch {
  messages: MailEnvelope[];
  /** Opaque cursor to store; pass back next time to get only newer changes. */
  cursor: string;
}

export interface GetChangesOptions {
  mailbox: string;
  folderId: string;
  cursor?: string | null;
  /** Used only for the first sync (no cursor): ignore mail received before this. */
  receivedAfter: Date;
}

/** Thrown by getChanges when the stored cursor is no longer valid; caller resets it and syncs again. */
export class CursorExpiredError extends Error {
  constructor() {
    super('Sync position expired; a fresh sync is needed');
    this.name = 'CursorExpiredError';
  }
}

export interface SearchQuery {
  mailbox: string;
  folderId: string;
  receivedFrom: Date;
  receivedTo: Date;
  onlyWithAttachments?: boolean;
  pageSize?: number;
  /** Opaque cursor from a previous page (null/undefined = first page). */
  pageCursor?: string | null;
}

export interface SearchPage {
  messages: MailEnvelope[];
  nextCursor: string | null;
}

/** Everything needed to save an email as a PDF. Fetched at save time, never stored. */
export interface EmailContent {
  subject: string;
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  receivedAt: Date;
  body: { type: 'html' | 'text'; content: string };
  /** Names of the real (not inline) attachments, listed in the PDF header. */
  attachmentNames: string[];
  /** Pictures embedded in the email (referenced as cid: in the HTML). */
  inlineImages: { contentId: string; name: string; contentType: string; base64: string }[];
}

export interface MailProvider {
  readonly type: ProviderType;
  testConnection(mailbox: string): Promise<ConnectionTestResult>;
  listFolders(mailbox: string): Promise<MailFolderInfo[]>;
  getChanges(opts: GetChangesOptions): Promise<ChangeBatch>;
  /** Date-range search in one folder, newest first, paged. Used by Rule Testing and historical jobs. */
  search(q: SearchQuery): Promise<SearchPage>;
  getMessage(ref: MailRef): Promise<MailEnvelope>;
  getBodyText(ref: MailRef): Promise<string>;
  getEmailContent(ref: MailRef): Promise<EmailContent>;
  listAttachments(ref: MailRef): Promise<AttachmentInfo[]>;
  openAttachment(ref: MailRef, attachmentId: string): Promise<NodeJS.ReadableStream>;
}
