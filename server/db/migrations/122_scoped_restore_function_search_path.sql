-- pg_restore clears the session search_path. Historical test schemas can have
-- their own SQL predicate and helper; bind each eligible predicate to its owner.
DO $$
DECLARE
  scoped_function RECORD;
BEGIN
  FOR scoped_function IN
    SELECT namespace.nspname, predicate.proname
      FROM pg_catalog.pg_proc AS predicate
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid=predicate.pronamespace
      JOIN pg_catalog.pg_language AS language ON language.oid=predicate.prolang
     WHERE predicate.proname='auto_listing_ai_runtime_safe_identifier'
       AND predicate.prokind='f' AND language.lanname='sql'
       AND predicate.pronargs=1 AND predicate.proargtypes[0]='pg_catalog.text'::pg_catalog.regtype
       AND EXISTS (
         SELECT 1 FROM pg_catalog.pg_proc AS helper
          WHERE helper.pronamespace=predicate.pronamespace
            AND helper.proname='auto_listing_ai_runtime_is_ip' AND helper.prokind='f'
            AND helper.pronargs=1 AND helper.proargtypes[0]='pg_catalog.text'::pg_catalog.regtype
       )
     ORDER BY namespace.nspname
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER FUNCTION %I.%I(pg_catalog.text) SET search_path = %I, pg_temp',
      scoped_function.nspname, scoped_function.proname, scoped_function.nspname
    );
  END LOOP;
END;
$$;
