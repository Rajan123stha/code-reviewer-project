-- Feedback loop: what happened to each posted comment.
ALTER TABLE "candidate_comments" ADD COLUMN "github_comment_id" BIGINT;
CREATE UNIQUE INDEX "candidate_comments_github_comment_id_key" ON "candidate_comments"("github_comment_id");

CREATE TABLE "comment_feedback" (
    "id" SERIAL NOT NULL,
    "candidate_comment_id" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail_json" JSONB,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_feedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "comment_feedback_candidate_comment_id_outcome_source_key" ON "comment_feedback"("candidate_comment_id", "outcome", "source");

ALTER TABLE "comment_feedback" ADD CONSTRAINT "comment_feedback_candidate_comment_id_fkey" FOREIGN KEY ("candidate_comment_id") REFERENCES "candidate_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Usage limits count a repository's reviews per day.
CREATE INDEX "reviews_started_at_idx" ON "reviews"("started_at");
