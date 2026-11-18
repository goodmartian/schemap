# schemap

Readable diagrams of large database schemas, made by your coding agent. Even at 200+ tables.

- **Sources:** SQL migrations, a live Postgres database, Prisma, DBML, or a written spec.
- **Result:** one HTML file that opens offline with a double click, or a private claude.ai artifact page to share by link.
- **The viewer:** tables grouped into modules, zoom from overview to columns, search (`/` or Cmd+K), click a table to light up its links with "many" and "one" marks, column notes, a "keys only" view, a filter for new and changing tables, a minimap, and links that open on one table.

Ask your agent: *"draw our database"*, *"show the schema from the migrations as a diagram"*, *"make a link to the database diagram for the manager"*.

## Install

As a Claude Code plugin:

```bash
claude plugin marketplace add goodmartian/schemap
```

```bash
claude plugin install schemap@schemap
```

As a skill for Claude Code, Codex, Gemini CLI, Cursor and other agents ([skills.sh](https://skills.sh/)):

```bash
npx skills add goodmartian/schemap -g -y
```

## What is inside

| Path | What it does |
|---|---|
| `skills/schemap/SKILL.md` | The workflow the agent follows |
| `skills/schemap/schema-format.md` | The `schema.json` format every step shares |
| `skills/schemap/scripts/build_diagram.py` | `schema.json` → diagram, with checks of the input and the layout |
| `skills/schemap/scripts/import_sql.py`, `import_prisma.py`, `import_dbml.py` | Sources → `schema.json` |
| `skills/schemap/scripts/schema_io.py` | What the importers share: text helpers, command line, writing and checking `schema.json` |
| `skills/schemap/scripts/postgres_schema.sql` | Read-only query: a live Postgres database → `schema.json` |
| `skills/schemap/scripts/viewer.template.html` | The viewer: one canvas, no libraries |
| `tests/run_checks.py` | The three importers read the same shop identically, and everything builds |

Python 3.9+ only, no packages. Check a copy with `python3 tests/run_checks.py`.

## Privacy

Nothing leaves the machine unless you ask for an artifact link. Artifacts are private to your claude.ai account until you share them. The Postgres query only reads the system catalogs; connection strings never go into files.

## По-русски

schemap рисует понятную схему базы данных, даже если в ней 200 таблиц. Источник — миграции, живая база, Prisma, DBML или текст спецификации. Результат — один HTML-файл без интернета или приватная ссылка-артефакт в claude.ai. Интерфейс просмотрщика — на русском или английском (`"lang": "ru"`).

## License

MIT
