-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "dispatchedAt" TIMESTAMP(3);

-- Existing notifications are history: never email them retroactively.
UPDATE "Notification" SET "dispatchedAt" = now();
