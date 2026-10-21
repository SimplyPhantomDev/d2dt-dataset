-- Keep the verification explanation separate from the original upload/hash.
BEGIN;

ALTER TABLE public.match_reports
ADD COLUMN IF NOT EXISTS verification_details JSONB
    CHECK (verification_details IS NULL
           OR jsonb_typeof(verification_details) = 'object');

COMMIT;