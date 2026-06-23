# Known Issues

## 1. `better-sqlite3` native module fails to load → "Failed to initialize database" (observability disabled)

**Status:** Open · environment / build issue (non-fatal — server still runs)
**Component:** `ecoxai/backend` (database / observability layer)
**First observed:** 2026-06-23, branch `feature/lit-novelty-skill`

### Symptom
On `npm start`, the backend logs one of:

```
Failed to initialize database: Error: The module '.../better-sqlite3/build/Release/better_sqlite3.node'
was compiled against a different Node.js version using NODE_MODULE_VERSION 127.
This version of Node.js requires NODE_MODULE_VERSION 120. ...
```
or (after a partial rebuild):
```
Failed to initialize database: Error: Could not locate the bindings file. Tried: ...
[DB] Not available — observability disabled: Could not locate the bindings file ...
```

The server **continues to start** on port 8081 and serves the UI; only the SQLite-backed
"observability" layer is disabled.

### Environment
- Multiple Node.js versions present on the machine:
  - nvm `v21.7.1` — **currently active**, `NODE_MODULE_VERSION` (ABI) = **120**
  - nvm `v22.9.0` — ABI **127**
  - Homebrew `node 23.11.0` — ABI 131
- `better-sqlite3@12.10.0`, `sqlite-vec@0.1.9`
- macOS arm64, Xcode CommandLineTools present, `python3` 3.9.12

### Root cause
`better-sqlite3` is a **native C++ addon**: Node loads a compiled `better_sqlite3.node`
binary that is tied to a specific Node ABI (`NODE_MODULE_VERSION`).

1. **Node version mismatch** — `node_modules` was originally installed/built under
   **Node 22 (ABI 127)**, but the app is now launched under **Node 21.7.1 (ABI 120)**.
   → "compiled against a different Node.js version" error.
2. **Failed partial rebuild** — `node_modules/better-sqlite3/build/` contains only
   intermediate artifacts (`obj.target`, `Makefile`, object files) and **no final
   `better_sqlite3.node`**. A rebuild was attempted but stopped **before the link step**,
   so the old Node-22 binary was removed and no Node-21 binary was produced.
   → "Could not locate the bindings file" error.

> Note: `sqlite-vec` ships a prebuilt `vec0.dylib` (a loadable SQLite extension, not a
> node-gyp build), so it is not itself the failure — it is loaded *into* better-sqlite3,
> which must load first.

### How the code handles it (why it is non-fatal)
`ecoxai/backend/server.js` wraps DB init in try/catch (graceful degradation):
```js
try { await dbManager.initialize(); }
catch (err) { console.warn('[DB] Not available — observability disabled:', err.message); }
```
`ecoxai/backend/services/databaseManager.js` has null guards (`if (!this.db) return / null / []`),
so DB-backed operations silently no-op when the binary is unavailable.

### Impact
**Disabled when DB is unavailable** (depends on `dbManager`):
- `routes/hypotheses.js` (21 call sites) — hypothesis persistence + **semantic similarity
  search** (`searchSimilar` / `saveEmbedding`, the sqlite-vec vector path / hypothesis RAG)
- `services/jobPostCompletion.js` (7) — run/step/tool-call tracing after job completion
- `services/containerManager.js` (6) — agent-run tracking
- `services/featureImportanceReporter.js` (1) — feature-importance result persistence

**Still works:** core pipeline (normalize → explore → hypothesize → analyze) and the
job/dataset lists — their source of truth is `data/state.json`, not the DB.

> Relevant to the `lit_novelty` skill work: if `lit_novelty` ties into the **hypotheses**
> store / semantic search, those paths will not function until the DB loads.

### Resolution options (not yet applied)
1. **Rebuild for the active Node** — `cd ecoxai/backend && npm rebuild better-sqlite3`
   (or `npm install`). First confirm *why* the 2026-06-23 rebuild failed before linking
   (typical causes: Xcode CLT / python / node-gyp toolchain).
2. **Run under the Node the modules were built for** — `nvm use 22.9.0 && npm start`
   (no rebuild needed; fastest).
3. **Pin a Node version for the project** — add an `.nvmrc` / `engines` field and document
   it in the README so install + run use the same ABI. (Prevents recurrence.)
