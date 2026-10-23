-- Shared limits and an immediate switch for the public issue endpoint.
BEGIN;

CREATE TABLE IF NOT EXISTS public.issue_report_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    per_ip_hour INTEGER NOT NULL DEFAULT 3 CHECK (per_ip_hour > 0),
    per_ip_day INTEGER NOT NULL DEFAULT 10 CHECK (per_ip_day > 0),
    global_minute INTEGER NOT NULL DEFAULT 3 CHECK (global_minute > 0),
    global_hour INTEGER NOT NULL DEFAULT 20 CHECK (global_hour > 0),
    global_day INTEGER NOT NULL DEFAULT 100 CHECK (global_day > 0)
);

INSERT INTO public.issue_report_settings (singleton)
VALUES (TRUE) ON CONFLICT (singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.issue_report_reservations (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_hash TEXT NOT NULL CHECK (client_hash ~ '^[a-f0-9]{64}$'),
    content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS issue_report_reservations_time_idx
    ON public.issue_report_reservations (reserved_at DESC);

CREATE INDEX IF NOT EXISTS issue_report_reservations_client_idx
    ON public.issue_report_reservations (client_hash, reserved_at DESC);

CREATE OR REPLACE FUNCTION public.reserve_issue_report(
    p_client TEXT, p_content TEXT
)
RETURNS TABLE (decision TEXT, retry_after INTEGER)
LANGUAGE plpgsql VOLATILE
AS $$
DECLARE
    settings public.issue_report_settings%ROWTYPE;
    checked_at TIMESTAMPTZ;
    blocked_until TIMESTAMPTZ;
    next_slot TIMESTAMPTZ;
    rule RECORD;
BEGIN
    IF p_client IS NULL OR p_client !~ '^[a-f0-9]{64}$'
        OR p_content IS NULL OR p_content !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION 'Invalid issue-report fingerprints.';
    END IF;

    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Issue-report limits require READ COMMITTED.';
    END IF;

    -- Serialize reservations across all instances. Read time after the lock.
    SELECT * INTO settings FROM public.issue_report_settings
    WHERE singleton = TRUE FOR UPDATE;

    IF NOT FOUND OR NOT settings.enabled THEN
        RETURN QUERY SELECT 'disabled'::TEXT, NULL::INTEGER;
        RETURN;
    END IF;

    checked_at := clock_timestamp();

    SELECT r.reserved_at + INTERVAL '10 minutes' INTO next_slot
    FROM public.issue_report_reservations r
    WHERE r.client_hash = p_client AND r.content_hash = p_content
      AND r.reserved_at > checked_at - INTERVAL '10 minutes'
    ORDER BY r.reserved_at DESC LIMIT 1;

    IF FOUND THEN
        RETURN QUERY SELECT 'duplicate'::TEXT,
            GREATEST(
                1,
                CEIL(EXTRACT(EPOCH FROM next_slot - checked_at))::INTEGER
            );
        RETURN;
    END IF;

    FOR rule IN
        SELECT * FROM (VALUES
            (3600, settings.per_ip_hour, TRUE),
            (86400, settings.per_ip_day, TRUE),
            (60, settings.global_minute, FALSE),
            (3600, settings.global_hour, FALSE),
            (86400, settings.global_day, FALSE)
        ) AS limits(seconds, maximum, client_only)
    LOOP
        SELECT r.reserved_at + make_interval(secs => rule.seconds)
        INTO next_slot
        FROM public.issue_report_reservations r
        WHERE r.reserved_at > checked_at - make_interval(secs => rule.seconds)
          AND (NOT rule.client_only OR r.client_hash = p_client)
        ORDER BY r.reserved_at DESC, r.id DESC
        OFFSET (rule.maximum - 1) LIMIT 1;

        IF FOUND THEN
            blocked_until := GREATEST(blocked_until, next_slot);
        END IF;
    END LOOP;

    IF blocked_until > checked_at THEN
        RETURN QUERY SELECT 'limited'::TEXT,
            GREATEST(
                1,
                CEIL(EXTRACT(EPOCH FROM blocked_until - checked_at))::INTEGER
            );
        RETURN;
    END IF;

    DELETE FROM public.issue_report_reservations
    WHERE reserved_at < checked_at - INTERVAL '48 hours';

    -- Reserve before GitHub. Failed or uncertain attempts remain counted.
    INSERT INTO public.issue_report_reservations (client_hash, content_hash)
    VALUES (p_client, p_content);

    RETURN QUERY SELECT 'allowed'::TEXT, NULL::INTEGER;
END;
$$;

COMMIT;