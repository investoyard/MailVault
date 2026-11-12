-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "MailProviderType" AS ENUM ('M365', 'GMAIL');

-- CreateEnum
CREATE TYPE "MailboxAuthMode" AS ENUM ('APP_ONLY', 'DELEGATED');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('PENDING_SETUP', 'CONNECTED', 'SYNCING', 'WARNING', 'REAUTH_REQUIRED', 'DISCONNECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "DestinationStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'LOW_SPACE', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "DuplicatePolicy" AS ENUM ('SKIP', 'REPLACE', 'RENAME', 'SMART');

-- CreateEnum
CREATE TYPE "ProcessTrigger" AS ENUM ('AUTO', 'MANUAL_SYNC', 'HISTORICAL', 'RULE_TEST', 'REPROCESS', 'RETRY');

-- CreateEnum
CREATE TYPE "AttachmentKind" AS ENUM ('FILE', 'ITEM', 'REFERENCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DownloadStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILED', 'SKIPPED', 'RETRYING', 'WAITING_DESTINATION', 'AWAITING_MANUAL');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "entraObjectId" TEXT,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "permissions" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserMailboxAccess" (
    "userId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,

    CONSTRAINT "UserMailboxAccess_pkey" PRIMARY KEY ("userId","mailboxId")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "provider" "MailProviderType" NOT NULL DEFAULT 'M365',
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "authMode" "MailboxAuthMode" NOT NULL DEFAULT 'APP_ONLY',
    "status" "MailboxStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "syncIntervalMinutes" INTEGER,
    "monitoringStartAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encryptedToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailboxFolder" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "providerFolderId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "includeSubfolders" BOOLEAN NOT NULL DEFAULT false,
    "deltaLink" TEXT,
    "lastSyncAt" TIMESTAMP(3),

    CONSTRAINT "MailboxFolder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Destination" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basePath" TEXT NOT NULL,
    "createIfMissing" BOOLEAN NOT NULL DEFAULT true,
    "lowSpaceThresholdMb" INTEGER NOT NULL DEFAULT 1024,
    "status" "DestinationStatus" NOT NULL DEFAULT 'UNKNOWN',
    "freeSpaceMb" BIGINT,
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Destination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mailboxId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "stopFurtherRules" BOOLEAN NOT NULL DEFAULT false,
    "simulationMode" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB NOT NULL,
    "attachments" JSONB NOT NULL,
    "destinationId" TEXT NOT NULL,
    "download" JSONB NOT NULL,
    "duplicatePolicy" "DuplicatePolicy" NOT NULL DEFAULT 'SMART',
    "autoDownload" BOOLEAN NOT NULL DEFAULT true,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "folderId" TEXT,
    "fromEmail" TEXT NOT NULL,
    "fromName" TEXT,
    "toEmails" TEXT[],
    "ccEmails" TEXT[],
    "subject" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "hasAttachments" BOOLEAN NOT NULL,
    "evaluatedAt" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MessageRuleMatch" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" INTEGER NOT NULL,
    "trigger" "ProcessTrigger" NOT NULL DEFAULT 'AUTO',
    "runNumber" INTEGER NOT NULL DEFAULT 1,
    "triggeredById" TEXT,
    "correlationId" TEXT NOT NULL,
    "matchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageRuleMatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "providerAttachmentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contentType" TEXT,
    "sizeBytes" INTEGER NOT NULL,
    "isInline" BOOLEAN NOT NULL DEFAULT false,
    "kind" "AttachmentKind" NOT NULL DEFAULT 'FILE',
    "sha256" TEXT,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttachmentDownload" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "status" "DownloadStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "destinationPath" TEXT,
    "finalFileName" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "sha256" TEXT,
    "bytesWritten" BIGINT,
    "downloadedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttachmentDownload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "trigger" "ProcessTrigger" NOT NULL DEFAULT 'AUTO',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "messagesScanned" INTEGER NOT NULL DEFAULT 0,
    "messagesMatched" INTEGER NOT NULL DEFAULT 0,
    "downloaded" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "correlationId" TEXT NOT NULL,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HistoricalJob" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "ruleIds" TEXT[],
    "dateFrom" TIMESTAMP(3) NOT NULL,
    "dateTo" TIMESTAMP(3) NOT NULL,
    "simulate" BOOLEAN NOT NULL DEFAULT true,
    "includeProcessed" BOOLEAN NOT NULL DEFAULT false,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "matched" INTEGER NOT NULL DEFAULT 0,
    "downloaded" INTEGER NOT NULL DEFAULT 0,
    "checkpoint" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "HistoricalJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" "AlertSeverity" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "alertKey" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "link" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationRecipient" (
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "NotificationRecipient_pkey" PRIMARY KEY ("notificationId","userId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingLog" (
    "id" BIGSERIAL NOT NULL,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "correlationId" TEXT,
    "mailboxId" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessingLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceHeartbeat" (
    "instanceId" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "pid" INTEGER NOT NULL,
    "memoryMb" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastBeatAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceHeartbeat_pkey" PRIMARY KEY ("instanceId")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DailyStat" (
    "day" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL DEFAULT '',
    "ruleId" TEXT NOT NULL DEFAULT '',
    "emailsScanned" INTEGER NOT NULL DEFAULT 0,
    "emailsMatched" INTEGER NOT NULL DEFAULT 0,
    "downloadsSucceeded" INTEGER NOT NULL DEFAULT 0,
    "downloadsFailed" INTEGER NOT NULL DEFAULT 0,
    "downloadsSkipped" INTEGER NOT NULL DEFAULT 0,
    "bytesDownloaded" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "DailyStat_pkey" PRIMARY KEY ("day","mailboxId","ruleId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_entraObjectId_key" ON "User"("entraObjectId");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_email_key" ON "Mailbox"("email");

-- CreateIndex
CREATE UNIQUE INDEX "MailboxFolder_mailboxId_providerFolderId_key" ON "MailboxFolder"("mailboxId", "providerFolderId");

-- CreateIndex
CREATE UNIQUE INDEX "Destination_name_key" ON "Destination"("name");

-- CreateIndex
CREATE INDEX "Rule_mailboxId_enabled_priority_idx" ON "Rule"("mailboxId", "enabled", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_mailboxId_name_key" ON "Rule"("mailboxId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_ruleId_version_key" ON "RuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX "Message_receivedAt_idx" ON "Message"("receivedAt");

-- CreateIndex
CREATE INDEX "Message_fromEmail_idx" ON "Message"("fromEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Message_mailboxId_providerMessageId_key" ON "Message"("mailboxId", "providerMessageId");

-- CreateIndex
CREATE INDEX "MessageRuleMatch_ruleId_matchedAt_idx" ON "MessageRuleMatch"("ruleId", "matchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRuleMatch_messageId_ruleId_runNumber_key" ON "MessageRuleMatch"("messageId", "ruleId", "runNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_messageId_providerAttachmentId_key" ON "Attachment"("messageId", "providerAttachmentId");

-- CreateIndex
CREATE INDEX "AttachmentDownload_status_nextAttemptAt_idx" ON "AttachmentDownload"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "AttachmentDownload_createdAt_idx" ON "AttachmentDownload"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentDownload_matchId_attachmentId_key" ON "AttachmentDownload"("matchId", "attachmentId");

-- CreateIndex
CREATE INDEX "SyncRun_mailboxId_startedAt_idx" ON "SyncRun"("mailboxId", "startedAt");

-- CreateIndex
CREATE INDEX "Notification_alertKey_resolvedAt_idx" ON "Notification"("alertKey", "resolvedAt");

-- CreateIndex
CREATE INDEX "Notification_createdAt_idx" ON "Notification"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ProcessingLog_createdAt_idx" ON "ProcessingLog"("createdAt");

-- CreateIndex
CREATE INDEX "ProcessingLog_correlationId_idx" ON "ProcessingLog"("correlationId");

-- AddForeignKey
ALTER TABLE "UserMailboxAccess" ADD CONSTRAINT "UserMailboxAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserMailboxAccess" ADD CONSTRAINT "UserMailboxAccess_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailboxFolder" ADD CONSTRAINT "MailboxFolder_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Destination"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRuleMatch" ADD CONSTRAINT "MessageRuleMatch_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageRuleMatch" ADD CONSTRAINT "MessageRuleMatch_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentDownload" ADD CONSTRAINT "AttachmentDownload_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "MessageRuleMatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentDownload" ADD CONSTRAINT "AttachmentDownload_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HistoricalJob" ADD CONSTRAINT "HistoricalJob_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationRecipient" ADD CONSTRAINT "NotificationRecipient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
