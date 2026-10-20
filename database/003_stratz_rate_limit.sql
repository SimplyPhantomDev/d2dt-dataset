-- Serialize quota checks across all processes sharing the 'primary' pool.
-- Rolling windows also protect against bursts around clock-hour boundaries.
BEGIN;

CREATE OR REPLACE FUNCTION public.reserve_stratz_request(
    p_budget_key TEXT,
    p_purpose TEXT
)
RETURNS TABLE (allowed BOOLEAN, retry_at TIMESTAMPTZ)
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    budget public.stratz_api_budgets%ROWTYPE;
    checked_at TIMESTAMPTZ;
    blocked_until TIMESTAMPTZ;
    window_retry_at TIMESTAMPTZ;
    rule RECORD;
BEGIN
    IF p_purpose IS NULL OR p_purpose NOT IN ('dataset', 'verification') THEN
        RAISE EXCEPTION 'Unknown STRATZ request purpose.' USING ERRCODE = '22023';
    END IF;

    -- Each query must see reservations committed while waiting for the lock.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'STRATZ quota checks require READ COMMITTED.';
    END IF;

    SELECT * INTO budget
    FROM public.stratz_api_budgets
    WHERE budget_key = p_budget_key
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'STRATZ budget configuration is missing.';
    END IF;

    checked_at := clock_timestamp();
    blocked_until := budget.paused_until;

    FOR rule IN
        SELECT * FROM (VALUES
            (1, budget.max_per_second, NULL::TEXT),
            (60, budget.max_per_minute, NULL::TEXT),
            (3600, budget.max_per_hour, NULL::TEXT),
            (86400, budget.max_per_day, NULL::TEXT),
            (3600, budget.verification_max_per_hour, 'verification'),
            (86400, budget.verification_max_per_day, 'verification')
        ) AS windows(window_seconds, call_limit, purpose_filter)
        WHERE purpose_filter IS NULL OR purpose_filter = p_purpose
    LOOP
        -- The Nth newest reservation determines when a limit has space again.
        -- This also works if an operator lowers a limit below current usage.
        SELECT r.reserved_at + make_interval(secs => rule.window_seconds)
        INTO window_retry_at
        FROM public.stratz_api_reservations r
        WHERE r.budget_key = p_budget_key
          AND r.reserved_at > checked_at - make_interval(secs => rule.window_seconds)
          AND (rule.purpose_filter IS NULL OR r.purpose = rule.purpose_filter)
        ORDER BY r.reserved_at DESC, r.id DESC
        OFFSET (rule.call_limit - 1) LIMIT 1;

        IF FOUND THEN
            blocked_until := GREATEST(blocked_until, window_retry_at);
        END IF;
    END LOOP;

    IF blocked_until > checked_at THEN
        RETURN QUERY SELECT FALSE, blocked_until + INTERVAL '10 milliseconds';
        RETURN;
    END IF;

    -- Only the last 24 hours affect quota; retain 48 hours for inspection.
    DELETE FROM public.stratz_api_reservations
    WHERE budget_key = p_budget_key
      AND reserved_at < checked_at - INTERVAL '48 hours';

    INSERT INTO public.stratz_api_reservations (budget_key, purpose)
    VALUES (p_budget_key, p_purpose);

    RETURN QUERY SELECT TRUE, NULL::TIMESTAMPTZ;
END;
$$;

COMMIT;