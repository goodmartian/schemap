-- A live Postgres database (11+) → schema.json for build_diagram.py, as one line of JSON.
--   psql "$DATABASE_URL" -X -A -t -f postgres_schema.sql -o schema.json
-- Read-only: it only selects from the system catalogs. Every schema except the system ones becomes a module;
-- drop the modules you do not want from schema.json afterwards (and their tables and references).
-- Partitions are left out (their parent table stands for them); so are foreign keys to tables outside the result.
WITH t AS (
  SELECT c.oid, n.nspname AS schema, c.relname AS name, obj_description(c.oid, 'pg_class') AS note
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND NOT c.relispartition
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_toast%'
    AND n.nspname NOT LIKE 'pg\_temp%'
),
cols AS (
  SELECT a.attrelid AS oid, a.attnum,
         json_build_object(
           'name', a.attname,
           -- the short spellings people write in migrations: timestamptz, varchar(50)
           'type', replace(replace(replace(replace(format_type(a.atttypid, a.atttypmod),
                     'timestamp with time zone', 'timestamptz'), 'timestamp without time zone', 'timestamp'),
                     'time with time zone', 'timetz'), 'character varying', 'varchar'),
           'pk', COALESCE(a.attnum = ANY (pk.conkey), false),
           'nullable', NOT a.attnotnull,
           'note', COALESCE(col_description(a.attrelid, a.attnum), '')) AS col
  FROM pg_attribute a
  JOIN t ON t.oid = a.attrelid
  LEFT JOIN pg_constraint pk ON pk.conrelid = a.attrelid AND pk.contype = 'p'
  WHERE a.attnum > 0 AND NOT a.attisdropped
),
fks AS (
  SELECT json_build_object(
           'from', json_build_object(
             'table', fn.nspname || '.' || fc.relname,
             'columns', (SELECT json_agg(att.attname ORDER BY k.ord)
                         FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
                         JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum)),
           'to', json_build_object(
             'table', tn.nspname || '.' || tc.relname,
             'columns', (SELECT json_agg(att.attname ORDER BY k.ord)
                         FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
                         JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum))) AS ref
  FROM pg_constraint con
  JOIN pg_class fc ON fc.oid = con.conrelid
  JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  JOIN pg_class tc ON tc.oid = con.confrelid
  JOIN pg_namespace tn ON tn.oid = tc.relnamespace
  WHERE con.contype = 'f'
    AND con.conparentid = 0
    AND con.conrelid IN (SELECT oid FROM t)
    AND con.confrelid IN (SELECT oid FROM t)
)
SELECT json_build_object(
  'title', current_database(),
  'lang', 'en',
  'modules', (SELECT json_agg(json_build_object('code', s, 'name', s) ORDER BY s) FROM (SELECT DISTINCT schema AS s FROM t) m),
  'tables', (SELECT json_agg(json_build_object(
                'id', t.schema || '.' || t.name,
                'name', t.name,
                'module', t.schema,
                'note', COALESCE(t.note, ''),
                'columns', (SELECT json_agg(col ORDER BY attnum) FROM cols WHERE cols.oid = t.oid))
              ORDER BY t.schema, t.name)
             FROM t),
  'refs', COALESCE((SELECT json_agg(ref) FROM fks), '[]'::json)
);
