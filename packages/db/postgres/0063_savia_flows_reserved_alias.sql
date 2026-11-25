DO $migration$
DECLARE
  function_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'savia_core.savia_flows_capture_collection_event()'::regprocedure
  ) INTO function_definition;
  IF position('studio_objects current_schema' IN function_definition) > 0 THEN
    function_definition := replace(function_definition, 'current_schema', 'active_schema');
  ELSIF position('studio_objects active_schema' IN function_definition) = 0 THEN
    RAISE EXCEPTION 'Unexpected Savia Flows collection trigger definition.';
  END IF;
  EXECUTE function_definition;
END;
$migration$;
