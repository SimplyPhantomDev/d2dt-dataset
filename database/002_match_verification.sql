-- Queue unique match IDs, cache fetched match records, and prepare shared
-- request accounting. This migration makes no calls to STRATZ.
BEGIN;

-- Jobs remain available for later reports about the same match. The worker
-- will process jobs that still have unverified reports attached to them.
CREATE TABLE IF NOT EXISTS public.match_verification_jobs (
    match_id BIGINT PRIMARY KEY CHECK (match_id > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    last_error_code TEXT
        CHECK (last_error_code ~ '^[a-z0-9_]{1,64}$'),
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS match_verification_jobs_due_idx
    ON public.match_verification_jobs (next_attempt_at, created_at);

CREATE INDEX IF NOT EXISTS match_reports_unverified_match_idx
    ON public.match_reports (match_id)
    WHERE verification = 'unverified' AND match_id IS NOT NULL;

-- Only the future verification worker writes this cache. Client claims
-- remain in match_reports and do not populate trusted match data.
CREATE TABLE IF NOT EXISTS public.stratz_match_cache (
    match_id BIGINT PRIMARY KEY
        REFERENCES public.match_verification_jobs (match_id),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    schema SMALLINT NOT NULL DEFAULT 1 CHECK (schema = 1),
    match_data JSONB NOT NULL CHECK (jsonb_typeof(match_data) = 'object')
);

-- 'primary' identifies the shared quota pool; no API token is stored here.
-- These limits are configuration for the rate limiter added in the next step.
CREATE TABLE IF NOT EXISTS public.stratz_api_budgets (
    budget_key TEXT PRIMARY KEY,
    max_per_second INTEGER NOT NULL CHECK (max_per_second > 0),
    max_per_minute INTEGER NOT NULL CHECK (max_per_minute > 0),
    max_per_hour INTEGER NOT NULL CHECK (max_per_hour > 0),
    max_per_day INTEGER NOT NULL CHECK (max_per_day > 0),
    verification_max_per_hour INTEGER NOT NULL
        CHECK (verification_max_per_hour > 0),
    verification_max_per_day INTEGER NOT NULL
        CHECK (verification_max_per_day > 0),
    paused_until TIMESTAMPTZ,
    CHECK (verification_max_per_hour <= max_per_hour),
    CHECK (verification_max_per_day <= max_per_day)
);

INSERT INTO public.stratz_api_budgets (
    budget_key, max_per_second, max_per_minute, max_per_hour,
    max_per_day, verification_max_per_hour, verification_max_per_day
)
VALUES ('primary', 20, 250, 2000, 10000, 300, 5000)
ON CONFLICT (budget_key) DO NOTHING;

-- The limiter will reserve one row before each API attempt. Reservations
-- stay counted after a crash or failed response, which is conservative.
CREATE TABLE IF NOT EXISTS public.stratz_api_reservations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    budget_key TEXT NOT NULL
        REFERENCES public.stratz_api_budgets (budget_key),
    purpose TEXT NOT NULL CHECK (purpose IN ('dataset', 'verification')),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS stratz_api_reservations_window_idx
    ON public.stratz_api_reservations (budget_key, reserved_at)
    INCLUDE (purpose);

-- Enqueueing is part of the report's transaction: saving cannot succeed
-- while silently losing the associated verification job.
CREATE OR REPLACE FUNCTION public.enqueue_match_verification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO public.match_verification_jobs (match_id)
    VALUES (NEW.match_id)
    ON CONFLICT (match_id) DO NOTHING;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER match_reports_enqueue_verification
AFTER INSERT OR UPDATE OF match_id ON public.match_reports
FOR EACH ROW
WHEN (NEW.match_id IS NOT NULL AND NEW.verification = 'unverified')
EXECUTE FUNCTION public.enqueue_match_verification();

-- Include reports received before this migration. Existing jobs, reports,
-- cached data and customized budgets are preserved when it is rerun.
INSERT INTO public.match_verification_jobs (match_id)
SELECT DISTINCT match_id
FROM public.match_reports
WHERE match_id IS NOT NULL AND verification = 'unverified'
ORDER BY match_id
ON CONFLICT (match_id) DO NOTHING;

COMMIT;