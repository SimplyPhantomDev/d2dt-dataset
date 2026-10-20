-- Persistent inbox for completed-draft reports received by the future API.
-- The draft ID prevents repeated uploads of one saved snapshot from adding rows.
-- The complete snapshot remains in report for later verification and training.

BEGIN;

CREATE TABLE IF NOT EXISTS public.match_reports (
    draft_id UUID PRIMARY KEY,
    outcome TEXT NOT NULL
        CHECK (outcome IN ('ally-win', 'ally-loss')),

    -- Client time is descriptive; received_at is assigned by the database.
    reported_at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Receiving a report does not establish that its outcome is true.
    verification TEXT NOT NULL DEFAULT 'unverified'
        CHECK (verification IN ('unverified', 'verified', 'rejected')),
    match_id BIGINT CHECK (match_id > 0),

    -- The receiver will compute this hash to detect conflicting upload retries.
    payload_sha256 TEXT NOT NULL
        CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
    report JSONB NOT NULL
        CHECK (jsonb_typeof(report) = 'object')
);

CREATE INDEX IF NOT EXISTS match_reports_received_at_idx
    ON public.match_reports (received_at);

COMMIT;