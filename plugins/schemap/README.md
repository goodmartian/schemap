# schemap

A skill for coding agents that draws a database schema as one HTML file or a claude.ai artifact.

Sources: SQL migrations, a Postgres database, Prisma, DBML, or a written spec.

The viewer has search, a minimap, a click on a reference line to ride to the table it points at (Backspace goes back), a keys-only view, a filter for new and changed tables, light and dark themes, links to a single table, export to DBML and SQL for dbdiagram.io, ChartDB, drawDB and draw.io, and, in a claude.ai artifact, comments on a table or a column that can be sent to Claude. The interface is in English or Russian.

## Usage

Ask the agent to draw the database. The steps it follows are in [`SKILL.md`](skills/schemap/SKILL.md), the input format in [`schema-format.md`](skills/schemap/schema-format.md).

To build a page by hand:

```bash
node skills/schemap/check.mjs schema.json -o diagram.html
```

## Requirements

- The page needs only a browser.
- `check.mjs` and the importers in `skills/schemap/importers/` need Node 18+.

## What the plugin runs

- `check.mjs` and the importers read local files and write `schema.json` and the page. No network.
- `psql` with `importers/postgres_schema.sql` runs one read-only query against the system catalogs of the database the user names. The connection string stays in the user's environment and is not written to files.
- The page loads nothing from the network.
- An artifact is published to claude.ai only when the user asks for a link. Its export menu saves a file only after the viewer confirms it.

## License

MIT. Icons in the viewer are from [Lucide](https://lucide.dev) (ISC; some MIT, © Cole Bemis).
