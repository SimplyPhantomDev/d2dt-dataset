BEGIN;

CREATE TABLE IF NOT EXISTS public.opendota_request_budget (
    name TEXT PRIMARY KEY,
    max_per_day INTEGER NOT NULL CHECK (max_per_day BETWEEN 1 AND 2500)
);

INSERT INTO public.opendota_request_budget (name, max_per_day)
VALUES ('public-matches', 1000)
ON CONFLICT (name) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.opendota_request_reservations (
    request_token UUID PRIMARY KEY,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS opendota_reservations_time_idx
    ON public.opendota_request_reservations (reserved_at, request_token);

CREATE OR REPLACE FUNCTION public.reserve_public_match_request(p_token UUID)
RETURNS TABLE (allowed BOOLEAN, retry_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    request_limit INTEGER;
    checked_at TIMESTAMPTZ;
    next_slot TIMESTAMPTZ;
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Public-match quota checks require READ COMMITTED.';
    END IF;

    SELECT max_per_day INTO request_limit
    FROM public.opendota_request_budget
    WHERE name = 'public-matches'
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Public-match budget configuration is missing.';
    END IF;

    checked_at := clock_timestamp();

    -- The Nth newest reservation also handles a lowered budget correctly.
    SELECT r.reserved_at + INTERVAL '24 hours' INTO next_slot
    FROM public.opendota_request_reservations r
    WHERE r.reserved_at > checked_at - INTERVAL '24 hours'
    ORDER BY r.reserved_at DESC, r.request_token DESC
    OFFSET (request_limit - 1) LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT FALSE, next_slot + INTERVAL '10 milliseconds';
        RETURN;
    END IF;

    DELETE FROM public.opendota_request_reservations
    WHERE reserved_at < checked_at - INTERVAL '48 hours';

    -- Reserve before HTTP. Failed or uncertain attempts remain counted.
    INSERT INTO public.opendota_request_reservations (request_token, reserved_at)
    VALUES (p_token, checked_at);

    RETURN QUERY SELECT TRUE, NULL::TIMESTAMPTZ;
END;
$$;

COMMIT;