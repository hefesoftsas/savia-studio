-- Keep composite expression indexes small enough for PostgreSQL's catalogs.
CREATE FUNCTION savia_core.studio_json_sort_rank(value json) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT CASE COALESCE(json_typeof(value), 'null')
    WHEN 'null' THEN 0
    WHEN 'number' THEN 1
    WHEN 'boolean' THEN 1
    ELSE 2
  END
$$;

CREATE FUNCTION savia_core.studio_json_sort_number(value json) RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
-- Float-to-text output must be stable across sessions that write or seek the index.
SET extra_float_digits = 1
AS $$
  SELECT CASE json_typeof(value)
    WHEN 'number' THEN CASE WHEN (value #>> '{}') ~ '[.eE]'
      THEN ((value #>> '{}')::double precision)::text::numeric
      ELSE (value #>> '{}')::numeric
    END
    WHEN 'boolean' THEN ((value #>> '{}') = 'true')::integer
    ELSE 0
  END
$$;

CREATE FUNCTION savia_core.studio_json_sort_text(value json) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN json_typeof(value) = 'string' THEN value #>> '{}'
    WHEN json_typeof(value) IN ('array', 'object')
      THEN regexp_replace(value::text, '("(?:[^"\\]|\\.)*")|\s+', '\1', 'g')
    ELSE ''
  END
$$;

-- Startup recreates configured indexes from their metadata with the new keys.
-- Leave timestamp-only indexes and indexes outside of Studio's naming scheme.
DO $$
DECLARE legacy_index record;
BEGIN
  FOR legacy_index IN
    SELECT index_class.relname
    FROM pg_catalog.pg_index AS item
    JOIN pg_catalog.pg_class AS index_class ON index_class.oid = item.indexrelid
    WHERE item.indrelid = 'savia_core.studio_records'::regclass
      AND item.indexprs IS NOT NULL
      AND index_class.relname ~ '^studio_perf_[0-9a-f]{40}$'
  LOOP
    EXECUTE format('DROP INDEX savia_core.%I', legacy_index.relname);
  END LOOP;
END
$$;
