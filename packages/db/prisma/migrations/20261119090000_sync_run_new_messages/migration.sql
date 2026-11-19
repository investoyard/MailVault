-- New emails stored by each sync run (shown on Monitoring > Sync History).
ALTER TABLE "SyncRun" ADD COLUMN "newMessages" INTEGER NOT NULL DEFAULT 0;
