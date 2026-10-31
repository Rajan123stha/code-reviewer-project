-- Verifier pass: per-review summary (calls, usage, verdict counts) and per-comment agreement.
ALTER TABLE "reviews" ADD COLUMN "verifier_json" JSONB;
ALTER TABLE "candidate_comments" ADD COLUMN "verifier_agreement" DOUBLE PRECISION;
ALTER TABLE "candidate_comments" ADD COLUMN "verifier_verdicts_json" JSONB;
