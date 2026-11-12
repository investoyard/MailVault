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

export interface MailProvider {
  readonly type: ProviderType;
  testConnection(mailbox: string): Promise<ConnectionTestResult>;
  listAttachments(ref: MailRef): Promise<AttachmentInfo[]>;
  openAttachment(ref: MailRef, attachmentId: string): Promise<NodeJS.ReadableStream>;
  // Phase 1: getChanges(cursor), search(query), getBodyText(ref)
}
