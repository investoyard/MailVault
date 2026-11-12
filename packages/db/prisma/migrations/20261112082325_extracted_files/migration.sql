-- CreateTable
CREATE TABLE "ExtractedFile" (
    "id" TEXT NOT NULL,
    "downloadId" TEXT NOT NULL,
    "innerPath" TEXT NOT NULL,
    "fileName" TEXT,
    "status" "DownloadStatus" NOT NULL,
    "reason" TEXT,
    "destinationPath" TEXT,
    "sha256" TEXT,
    "bytes" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExtractedFile_downloadId_idx" ON "ExtractedFile"("downloadId");

-- AddForeignKey
ALTER TABLE "ExtractedFile" ADD CONSTRAINT "ExtractedFile_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "AttachmentDownload"("id") ON DELETE CASCADE ON UPDATE CASCADE;
