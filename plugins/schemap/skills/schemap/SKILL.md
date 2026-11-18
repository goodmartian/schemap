---
name: schemap
description: Use when someone wants to see, explain, review or share a database schema as a diagram (an ERD of tables and foreign keys) from SQL migrations, a live Postgres database, Prisma, DBML or a written spec, especially a large schema of dozens to hundreds of tables, a reader who is not a programmer, planned schema changes to review, or a link to send to someone.
---

# schemap: database diagrams

The result is one HTML file that works offline, or a private claude.ai artifact page. It shows every table, column and foreign key, grouped into coloured modules, and stays readable at 200+ tables. Viewers can zoom, find a table, click a table to light up its links and read column notes. Highlighted links show "many" and "one" at their ends. A switch hides everything but keys (primary keys and both ends of every reference), which makes a big schema several times smaller. They can also filter by status (new / changing), move around with a minimap, and open a link that lands on one table.

Below, `<skill-dir>` is this skill's folder (the one that holds this SKILL.md). In it:

- `viewer.html` — the whole viewer. It reads `schema.json` from the page, checks it and lays it out in the browser. A page is `viewer.html` with the schema appended.
- `check.mjs` — checks `schema.json` with the viewer's own code and writes the page. Needs Node 18+.
- `importers/` — turn SQL, Prisma, DBML or a live Postgres database into `schema.json`. Need Python 3.9+. Optional: `schema.json` can also be written by hand.

## Workflow

1. **Get `schema.json`** from the source the project actually has (table below). Write it next to the diagram, in the user's project or in a folder they name.

   When the project has several sources, take the one the others are made from: a DBML or SQL file generated from a model or a database can be out of date. Compare their table, column and reference counts, and tell the user which source is behind.
2. **Read what the importer printed.** Pass every "not understood" or "left out" line to the user. Never fill a gap with a guess.
3. **Shape it for the reader.** This is the step that makes the diagram useful, so do not skip it:
   - **Modules.** Group tables into 4–12 domain modules. A database with a single schema (`public`) comes out as one module, and one module of 100 tables is unreadable. Group by name prefix and by foreign-key clusters, and name modules in the reader's words ("Orders and payments", not "sales").
   - **Titles and notes.** Give each table a human `title` in the reader's language. Add `note`s where a column's meaning is not obvious from its name. Take the words from the project (docs, comments, the spec). Do not invent meaning.
   - **Statuses.** When the diagram shows planned changes, mark tables as `new`, `changed` or `same`. The viewer then offers a status filter.
   - **Language.** Set `lang` to the reader's language (`en` or `ru`). It controls the viewer's interface.

   The format, with every field and its default, is in [schema-format.md](schema-format.md).
4. **Build:** `node "<skill-dir>/check.mjs" schema.json -o diagram.html`. It prints every problem in `schema.json` and writes nothing until there are none. Fix problems in `schema.json`, never in the HTML.

   Without Node, put the page together by hand and open it: the viewer shows the same problems in place of the diagram.

   ```bash
   { echo '<!doctype html>'; cat "<skill-dir>/viewer.html"; printf '<script id="schema" type="application/json">'; cat schema.json; echo '</script>'; } > diagram.html
   ```

   ```powershell
   "<!doctype html>`n" + (Get-Content -Raw "<skill-dir>\viewer.html") + '<script id="schema" type="application/json">' + (Get-Content -Raw schema.json) + '</script>' | Set-Content -Encoding utf8 diagram.html
   ```

   If any text in `schema.json` contains `</`, write it as `<\/` (the same string in JSON); `check.mjs` does this itself.
5. **Deliver** the way the user asked:
   - **File:** `diagram.html` opens with a double click, without a server or internet. A link of the form `diagram.html#<diagram>--<table>` opens on one table.
   - **Link (claude.ai artifact):** build with `--artifact` (`node "<skill-dir>/check.mjs" schema.json -o diagram.artifact.html --artifact`; by hand, leave out the `<!doctype html>` line), as artifacts take a page without its own `<html>`/`<head>`/`<body>`. Publish that file with the Artifact tool and pass the schema's title as `title`. The page is private to the user until they share it. A schema can be confidential (a client's or employer's database), so publish only when the user wants a link. In the page, choosing a table updates the claude.ai address, so Share → Copy link points at that table.
6. **Verify before saying it is done.** Compare the counts `check.mjs` printed (tables, columns, references) with the source. Open the result: on an artifact, click one table and check that its links light up. Report the numbers and anything the importer could not read.

To update a diagram later, change the source or `schema.json` and rebuild. Republish the artifact to the same URL.

## Sources

| The project has | Run | Notes |
|---|---|---|
| SQL migrations or a schema dump | `python3 "<skill-dir>/importers/import_sql.py" migrations/ -o schema.json` | Replays CREATE/ALTER/DROP TABLE and COMMENT ON in file-name order; goose and dbmate files, `*.up.sql` |
| A Postgres database (11+) | `psql "$DATABASE_URL" -X -A -t -f "<skill-dir>/importers/postgres_schema.sql" -o schema.json` | Exact, and read-only. Ask before connecting to anything but a local or development database. Never write a connection string into a file. Drop system modules (Supabase `auth`, `storage`…) the reader does not need |
| `schema.prisma` | `python3 "<skill-dir>/importers/import_prisma.py" prisma/schema.prisma -o schema.json` | Uses database names (`@@map`, `@map`); `///` comments become notes |
| A DBML file | `python3 "<skill-dir>/importers/import_dbml.py" schema.dbml -o schema.json` | `TableGroup`s become modules |
| Its own schema model: a JSON or YAML file that its DBML, SQL or docs are generated from | A short script in the project, next to the model, that maps it to `schema.json`; keep it so the diagram can be rebuilt | Usually the richest source: statuses, titles and notes live there, while DBML and SQL have no field for a title or a status. Its counts must match the model's |
| A written spec or docs, no code yet | Write `schema.json` by hand from the text, then `node "<skill-dir>/check.mjs" schema.json` | List every table the text names; keep the spec's own words for titles and notes |
| Another ORM (Rails, Django, Drizzle, TypeORM…) | Get SQL first: `rails db:schema:dump` with `structure.sql`, `python manage.py sqlmigrate`, `drizzle-kit export`, then `import_sql.py` | Or a live database, if one runs locally |
| Another database (MySQL, SQLite, SQL Server…) and no Python | Ask the database for its tables, columns and foreign keys (`information_schema`, `PRAGMA table_info`) and write `schema.json` from the answer | The format is small; [schema-format.md](schema-format.md) has an example |

The Python importers take `--title` (the page name) and `--lang`. The Postgres query writes the database name as `title` and `en` as `lang`; change them in `schema.json`.

## When the build or a page goes wrong

| Symptom | Cause and fix |
|---|---|
| `check.mjs` lists problems, or the page shows "The diagram did not open" with reasons | The named field is missing or wrong in `schema.json`. Fix it there |
| The page shows its own code as text | A `</` in `schema.json` closed the script early. Write it as `<\/`, or build with `check.mjs` |
| `references left out … table not in these files` | A foreign key points outside the migrations (e.g. Supabase `auth.users`). Tell the user. Add the table to `schema.json` only if it should be on the diagram |
| One huge grey area on the overview | Everything is in one module. Split it into domain modules (step 3) |
| Card names cut off with "…" | Names longer than the card. Expected; the full name is in the details panel |
| Artifact link opens the overview, not the table | The address has characters other than letters, digits and `-`. Use the address the page itself writes |
