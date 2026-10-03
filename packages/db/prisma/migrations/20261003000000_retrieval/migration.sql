-- pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "embedding_cache" (
    "key" TEXT NOT NULL,
    "vector" REAL[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "embedding_cache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "conventions" (
    "id" SERIAL NOT NULL,
    "repo_id" INTEGER NOT NULL,
    "rule_text" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "evidence_json" JSONB NOT NULL,

    CONSTRAINT "conventions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bug_history" (
    "id" SERIAL NOT NULL,
    "repo_id" INTEGER NOT NULL,
    "fix_commit_sha" TEXT NOT NULL,
    "bug_commit_sha" TEXT,
    "committed_at" TIMESTAMP(3) NOT NULL,
    "files_json" JSONB NOT NULL,
    "summary" TEXT NOT NULL,

    CONSTRAINT "bug_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" SERIAL NOT NULL,
    "symbol_id" INTEGER NOT NULL,
    "text_hash" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "embedding" vector(768),

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conventions_repo_id_idx" ON "conventions"("repo_id");

-- CreateIndex
CREATE INDEX "bug_history_repo_id_committed_at_idx" ON "bug_history"("repo_id", "committed_at");

-- CreateIndex
CREATE UNIQUE INDEX "bug_history_repo_id_fix_commit_sha_key" ON "bug_history"("repo_id", "fix_commit_sha");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_symbol_id_key" ON "chunks"("symbol_id");

-- AddForeignKey
ALTER TABLE "conventions" ADD CONSTRAINT "conventions_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bug_history" ADD CONSTRAINT "bug_history_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_symbol_id_fkey" FOREIGN KEY ("symbol_id") REFERENCES "symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
