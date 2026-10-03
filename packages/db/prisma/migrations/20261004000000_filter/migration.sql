-- Learned filter: keep each candidate's feature values and the model that scored the review.
ALTER TABLE "candidate_comments" ADD COLUMN "features_json" JSONB;
ALTER TABLE "reviews" ADD COLUMN "features_version" TEXT;
ALTER TABLE "reviews" ADD COLUMN "filter_model" TEXT;
