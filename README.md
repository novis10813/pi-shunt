# pi-shunt

A pi extension. It replaces whole-file reads of large code and markdown files
with a structure index, so the content stays out of the main context:

- code (`ts,tsx,js,jsx,mjs,cjs,py,rs,go,sh`): tree-sitter index with imports,
  top-level symbols, full signatures, one level of members, and line numbers.
- markdown: heading outline with line numbers.

Everything runs locally. Other file types, targeted reads, and small files pass
through unchanged. See [extensions/shunt/README.md](extensions/shunt/README.md).

Config is `<cwd>/.pi/shunt.json`. Without it, shunt is off.

## Install

```bash
pi install -l git:github.com/novis10813/pi-shunt
```

pi runs `npm install` for the package (one dependency, `@vscode/tree-sitter-wasm`).

## Development

```bash
npm install
npm test
```

Tests need the node that has pi installed (they resolve pi from
`process.execPath`).

The removed features (LLM worker, bash `cat`/`head`/`tail` blocking, csv/jsonl
profiles, read diagnostics, ripple) are kept on the `archive/full` branch.
Ripple now lives in [pi-ripple](https://github.com/novis10813/pi-ripple).
