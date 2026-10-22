BEGIN;

ALTER TABLE public.public_match_collection
ADD COLUMN IF NOT EXISTS last_page_at TIMESTAMPTZ;

COMMENT ON COLUMN public.public_match_collection.last_page_at IS
    'Last successfully saved source page, including an empty response; used to rotate sampling windows.';

-- Preserve visits made before this timestamp was introduced.
UPDATE public.public_match_collection
SET last_page_at = updated_at
WHERE name LIKE 'opendota-ranked-all-pick-v1:hour:%'
  AND next_match_id IS NOT NULL
  AND last_page_at IS NULL;

COMMIT;