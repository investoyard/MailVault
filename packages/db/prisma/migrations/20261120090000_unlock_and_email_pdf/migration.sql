-- Password removal for protected attachments + saving the email itself as PDF.
ALTER TYPE "AttachmentKind" ADD VALUE 'EMAIL_BODY';

CREATE TYPE "FileProtection" AS ENUM ('NONE', 'UNLOCKED', 'RESTRICTIONS_REMOVED', 'STILL_LOCKED');

ALTER TABLE "Rule" ADD COLUMN "filePasswords" TEXT;
ALTER TABLE "Rule" ADD COLUMN "filePasswordCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AttachmentDownload" ADD COLUMN "protection" "FileProtection";
ALTER TABLE "ExtractedFile" ADD COLUMN "protection" "FileProtection";
