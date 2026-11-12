// Shared constants used by api, worker and web. Keep in sync with packages/db/prisma/schema.prisma enums.

export const MAILBOX_AUTH_MODES = ['APP_ONLY', 'DELEGATED'] as const;
export type MailboxAuthMode = (typeof MAILBOX_AUTH_MODES)[number];

export const MAILBOX_STATUSES = [
  'PENDING_SETUP',
  'CONNECTED',
  'SYNCING',
  'WARNING',
  'REAUTH_REQUIRED',
  'DISCONNECTED',
  'DISABLED',
] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

export const DOWNLOAD_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'SUCCESS',
  'FAILED',
  'SKIPPED',
  'RETRYING',
  'WAITING_DESTINATION',
  'AWAITING_MANUAL',
] as const;
export type DownloadStatus = (typeof DOWNLOAD_STATUSES)[number];

export const DUPLICATE_POLICIES = ['SKIP', 'REPLACE', 'RENAME', 'SMART'] as const;
export type DuplicatePolicy = (typeof DUPLICATE_POLICIES)[number];

export const DESTINATION_STATUSES = ['UNKNOWN', 'HEALTHY', 'LOW_SPACE', 'UNAVAILABLE'] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

export const PROCESS_TRIGGERS = ['AUTO', 'MANUAL_SYNC', 'HISTORICAL', 'RULE_TEST', 'REPROCESS', 'RETRY'] as const;
export type ProcessTrigger = (typeof PROCESS_TRIGGERS)[number];

export const ALERT_SEVERITIES = ['INFO', 'SUCCESS', 'WARNING', 'ERROR'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** pg-boss queue names shared by the API (sends jobs) and the worker (runs them). */
export const QUEUES = {
  syncScheduler: 'sync-scheduler',
  syncMailbox: 'sync-mailbox',
  processDownloads: 'process-downloads',
  folderHealth: 'folder-health',
} as const;

export interface SyncJob {
  mailboxId: string;
  trigger?: ProcessTrigger;
}

/** Human labels for statuses, used by the admin UI. */
export const DOWNLOAD_STATUS_LABELS: Record<DownloadStatus, string> = {
  PENDING: 'Pending',
  IN_PROGRESS: 'In progress',
  SUCCESS: 'Success',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  RETRYING: 'Retrying',
  WAITING_DESTINATION: 'Waiting for folder',
  AWAITING_MANUAL: 'Awaiting manual download',
};

export const MAILBOX_STATUS_LABELS: Record<MailboxStatus, string> = {
  PENDING_SETUP: 'Pending setup',
  CONNECTED: 'Connected',
  SYNCING: 'Syncing',
  WARNING: 'Warning',
  REAUTH_REQUIRED: 'Reauthorization required',
  DISCONNECTED: 'Disconnected',
  DISABLED: 'Disabled',
};

/** File types blocked for every rule, regardless of rule settings. */
export const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp',
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'hta', 'cpl', 'jar', 'lnk', 'reg',
];
