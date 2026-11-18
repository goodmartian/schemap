# schemap

A skill for coding agents that draws a database schema as one HTML file or a claude.ai artifact.

![The orders table selected: its links highlighted, its columns in the side panel](docs/screenshots/table.webp)

What it does, how to use it and what it runs: [`plugins/schemap/README.md`](plugins/schemap/README.md).

## Install

As a Claude Code plugin:

```bash
claude plugin marketplace add goodmartian/schemap
```

```bash
claude plugin install schemap@schemap
```

As a skill for other agents, via [skills.sh](https://skills.sh/):

```bash
npx skills add goodmartian/schemap -g -y
```

## Example

[`examples/storefront`](examples/storefront): an online store with 49 tables, 250 columns, 71 references and 8 modules.

## Development

- Tests: `python3 tests/run_checks.py`.
- Screenshot: `bash docs/screenshots/make.sh`.

## License

MIT
