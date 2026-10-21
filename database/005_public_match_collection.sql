-- Store public training candidates independently of user-report verification.
BEGIN;

CREATE TABLE IF NOT EXISTS public.public_match_samples (
    match_id BIGINT PRIMARY KEY
        CHECK (match_id BETWEEN 1 AND 9007199254740991),
    collected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    match_data JSONB NOT NULL,
    CHECK ((
        jsonb_typeof(match_data) = 'object'
        AND match_data -> 'schema' = '1'::jsonb
        AND match_data ->> 'matchId' = match_id::text
        AND match_data #>> '{metadata,source}' = 'opendota'
    ) IS TRUE)
);

CREATE TABLE IF NOT EXISTS public.public_match_collection (
    name TEXT PRIMARY KEY,
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    next_match_id BIGINT
        CHECK (next_match_id BETWEEN 1 AND 9007199254740991),
    next_request_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))
);

-- Rerunning this migration must not reset collection progress.
INSERT INTO public.public_match_collection (name)
VALUES ('opendota-ranked-all-pick-v1')
ON CONFLICT (name) DO NOTHING;

COMMIT;