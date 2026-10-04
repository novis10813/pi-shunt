# pi-shunt-ripple

Two pi extensions that share one lint core.

| Extension | Hooks | What it does |
|---|---|---|
| [`shunt`](extensions/shunt/README.md) | `tool_result(read)`, `tool_call(bash)` | Replaces whole-file reads of large files with a structure index (tree-sitter for code, outline for markdown, profile for csv/jsonl) so the content stays out of the main context. Blocks `cat`/`head`/`tail` on large files. Registers no tool. |
| [`ripple`](extensions/ripple/README.md) | `tool_call(edit/write)`, `tool_result`, `turn_end` | After a turn, re-runs lint on edited files and records new diagnostics and stale references to renamed files for the next request. Never changes tool output. |

`shared/diagnostics/` is the lint core (biome, ruff, shellcheck) used by both.
shunt also uses it to annotate `read` results.

Both read per-project config from `<cwd>/.pi/`:

- `shunt.json`: shunt settings. Without it, shunt's summaries are off.
- `ripple.json`: ripple settings. Without it, ripple runs with defaults. Set `{"enabled": false}` to turn it off.
- `diagnostics.json`: optional shared lint settings.

## Install

Install per project so the hooks only run where you want them:

```bash
pi install -l git:github.com/novis10813/pi-shunt-ripple
```

Installing without `-l` enables both extensions in every project. ripple then
runs lint and `git grep` on every edit by default.

pi runs `npm install` for the package (one dependency, `@vscode/tree-sitter-wasm`).

## Development

```bash
npm install
npm test
```

Tests need the node that has pi installed (they resolve pi from
`process.execPath`).

## Docs

`docs/` holds the original design specs. Paths such as `.pi/extensions/shunt/`
in them refer to the layout before this repo existed. The repo root plays the
role of `.pi/` (`extensions/`, `shared/`).
