# shunt v2 Spec — 確定性結構摘要

- 狀態：提案（待 pre-flight review）
- 日期：2026-09-22
- 範圍：`.pi/extensions/shunt/`（index.ts / rules.ts / worker.ts / test-shunt.mjs / README.md）、`.pi/shunt.json`、`docs/pi-extensions.md`、根 `AGENTS.md`
- 上游依據：Spotify「Honk / Portal shunt」model-routing 做法（token 節省來自 routing/enforcement，非 LLM 摘要本身）；oh-my-pi `pi-ast`、Aider repomap、Roo Code folding 的確定性結構索引路線

## 1. 目標

把 shunt 的「大檔整檔讀取」摘要引擎從**純 LLM worker** 改成**分層引擎**：

1. code 檔 → 本地 tree-sitter 確定性結構索引（零成本、零延遲、原文不出機器、line range 零幻覺）
2. markdown / CSV / JSONL → 本地確定性 outline / profile
3. 其他文字 → 現行 LLM worker（保留，config 可關）

「agent 指定段落才回實際內容」的語意不變：targeted read（offset/limit、`:range` selector）一律放行，bash 規則不動，shunt 仍**不註冊任何 tool**（純 `tool_result` + `tool_call` hooks），與全域 `read-selector` override 疊加無衝突。

### 非目標（parked，另案追蹤）

- bash 規則三個 bypass（`2>/dev/null` 誤放行、多行命令、`head -c`）→ task t6
- `read` tool override / question parameter（已評估，本設計不需要）
- symbol grep 重新錨定指引、disk-level cache、worker prompt 改版

## 2. 現行行為（v1，基線）

- read rule（`tool_result` hook）：`isReadToolResult && !isError` → 讀 `<cwd>/.pi/shunt.json`（缺/壞 = 靜默停用）→ 非 targeted → `stat`（非 regular 或 size > `MAX_WORKER_CHARS` = 2,000,000 → 放行）→ `safeRead` 全檔 → `decideIntercept`（text、lines > `minLines`）→ `runWorker`（60s timeout、`ctx.signal` 可中斷、失敗 fail-open）→ 以 `[shunt] SUMMARY` label + 摘要取代結果，`details: { shunt: true, lines, worker }`。
- bash rule（`tool_call` hook）：`cat|head|tail|less|more` 大檔擋下（streaming probe 數行，early exit）。
- `rules.ts` 純模組（selector grammar mirror read-selector、`decideIntercept`、`detectBashReads`），`worker.ts` 純模組（prompt、numberLines、label）。測試：`test-shunt.mjs`（29 checks，含 fake-ctx 整合節段）。

## 3. 設計

### 3.1 判定樹（read rule，於 `decideIntercept` 決定 intercept 之後分層）

```
非 targeted 的整檔 read，成功、非 error
├─ targeted（offset/limit/:range）      → 放行（不變）
├─ image / binary / 缺失 / 非 regular   → 放行（不變）
├─ kind = detectKind(basePath)：
│   ├─ "code"（extension 有 grammar）且 size ≤ MAX_DETERMINISTIC_CHARS
│   │   → buildCodeIndex（tree-sitter）成功 → STRUCTURE label + index 取代
│   │   → parse 失敗 / 語法錯誤率過高 / engine 不可用 → 落入下一分支
│   ├─ "markdown" / "csv" / "jsonl" 且 size ≤ MAX_DETERMINISTIC_CHARS
│   │   → 對應 builder 成功 → 取代；失敗 → 落入下一分支
│   └─ "other"
│       → cfg.nonCode === "worker" → 現行 LLM worker 路徑（不變；size gate 仍為 MAX_WORKER_CHARS）
│       → cfg.nonCode === "passthrough" → 放行
所有 builder/engine 失敗一律 fail-open（原結果原封不動）。
```

- `MAX_DETERMINISTIC_CHARS = 20_000_000`（本地 parse/profile 記憶體可接受的上限；md/csv/jsonl 維持）。`MAX_CODE_PARSE_CHARS = 2_000_000`（2026-07-19 設計決策：tree-sitter WASM parse 同步跑在主 thread，code 檔逾 2MB 在 stat 層直接放行，不讀檔、不 parse、不落 worker）。【已實測：parse 時間約 1s/MB 線性——2MB≈1.7s／5MB≈4.4s／10MB≈9.4s／20MB≈19.1s 主 thread 凍結，20MB 峰值 RSS 1.75GB、無 OOM；2MB 為同步 parse 預算，將最壞凍結壓至 ≈1.7s。worker-thread parse 為候選（恢復大檔索引且不解凍主 thread），未授權實作】。v1 的 2MB gate 只保留給 worker 路徑。
- size gate 在 `stat` 後以 kind（僅依 extension 判定，不需讀檔）決定用哪一個 cap。
- `details`：`{ shunt: true, engine: "tree-sitter" | "markdown" | "csv" | "jsonl" | "worker", lines }`（`worker` 路徑與 v1 相容）。

### 3.2 kind 判定（`detectKind(path): "code" | "markdown" | "csv" | "jsonl" | "other"`）

純 extension 判定（case-insensitive，含多重點號取最後一段）：

| kind | extensions |
|---|---|
| code | 由 config `languages`（預設 `["ts","tsx","js","jsx","mjs","cjs","py","rs","go","sh"]`）映射到 grammar |
| markdown | `md`、`markdown` |
| csv | `csv`、`tsv` |
| jsonl | `jsonl`、`ndjson` |
| other | 其餘（含 `json`——單一大型 JSON 物件不 profile，走 worker/passthrough） |

無 extension、或 code 但不在 `languages` 清單 → `other`。

### 3.3 code index（tree-sitter）

- 輸出內容：
  1. `Imports:` 一行——import statement 的模組名（去路徑只留最後一段或整個 specifier，取 ≤20 個，多餘以 `+N` 收），附第一筆與最後筆的 line range。
  2. Top-level named definitions：function / class / interface / type / enum / const arrow / struct / impl / mod / def（依語言），每筆 `- name (kind) [start-end]`（1-indexed、含義與 read selector 相同）。function-like 條目（及 class/interface 的 method）附**完整簽名**於 name 之後：params＋型別＋回傳型別，保留各語言原生語法（TS `: T`、Python `-> T`、Rust `-> T`、Go 裸型別），多行簽名收斂為單行，**永不逐筆截斷**；class/struct/interface 的 field 帶型別註記。Rust 的 impl/trait block 把方法列為 members（Rust 型別的 contract 在 impl 上）。
  3. class / struct / interface 的直接 members（method / field）收一層，縮排一級；遞迴深度 ≤ 2。
  4. 未命名 top-level 區塊不出現。
- 錯誤容忍：parse 完成後統計 `ERROR`/`MISSING` 節點覆蓋的行數；**> 10% 總行數 → 視同非 code**（return undefined → 落下一分支）。
- Budget（backstop）：entries ≤ 400（超過 → 停止並附 `… +N more entries（total M；用 targeted read 取精確內容）`）；渲染總長 ≤ 40,000 chars（截斷附 `… (truncated)`）。簽名永不逐筆截斷——前提是真實 code 的簽名索引遠小於原文（典型 5–10%）；backstop 只防「產生的程式碼」邊界（萬個 top-level 長簽名函式）。
- 語言 → grammar 映射（預設集）：`ts→typescript`、`tsx→tsx`、`js/mjs/cjs→javascript`、`jsx→tsx`、`py→python`、`rs→rust`、`go→go`、`sh→bash`。config `languages` 只收縮/不擴充 grammar 集（擴充需改 code，防 config 注入不存在 grammar）。
- **S1 已定案的 grammar 事實**（2026-09-22 spike 驗證）：
  - `tsx.wasm` **可獨立 load**（CLI 0.25 建置已把 base language 內聯）——不需要、API 也不支援雙 grammar 注入；`.tsx`/`.jsx` 皆以 tsx grammar 解析。
  - `.jsx` 以 tsx grammar 解析：測試片段 error lines = 0（JS-only 邊緣語法若推高錯誤率 → 觸發 >10% 門檻時 fail-open 落 worker，可接受）。
  - TS/TSX 文法把 `export ...` 宣告包在 **`export_statement`** node 裡——index builder 必須 unwrap（取第一個 named child）。
  - TS class members：method 的 node type 是 **`method_definition`**（非 `class_method_definition`），field 是 `public_field_definition`。
  - 各語言的 top-level/member node type 映射（py: `function_definition`/`class_definition`；rs: `struct_item`/`impl_item`/`function_item`；go: `function_declaration`/`method_declaration`/`type_declaration`；bash: `function_declaration`）在 S2 實作，以 fixture 斷言驗證。
  - 簽名節點映射（2026-09-22 實測定案）：TS/JS params 為 `formal_parameters`、回傳型別為直接子 `type_annotation`；Python params 為 `parameters`、回傳型別是直接子 `type`（**無** `return_type` node）；Rust 回傳型別節點名多樣（`primitive_type`/`generic_type`/…）→ 用**位置規則**（parameters 後、where_clause/body 前的第一個 named child）；Go params 為 **`parameter_list`**（非 `parameters`）、單回傳是裸 type 節點 → 同用位置規則。

### 3.4 markdown / csv / jsonl profile（純文字，無 dependency）

- markdown outline：`## heading [line]`（保留級數，depth ≤ 6），entries ≤ 100，超額收尾標記同 3.3；無 heading → undefined（落下一分支）。
- csv/tsv：`CSV — N rows, K columns:` + 欄位名（≤20）+ 前 3 行樣本（每行截 80 chars）。空檔 / 只有 header → 仍產出（rows=0）。
- jsonl：`JSONL — N rows; keys in first 100 rows: a, b, c`（≤20 keys）+ 前 2 行樣本（截 120 chars）。行解析失敗率 > 10% → undefined。
- 樣本行一律只取**行首**（避免把長列整條送進 context）。

### 3.5 輸出 label（所有確定性引擎共用）

```
[shunt] STRUCTURE — not file content. "<path>" (<N> lines). Deterministic index (engine: <tree-sitter|markdown|csv|jsonl>).
For exact content, use a targeted read (offset/limit or a :range selector).
```

worker 路徑的 `[shunt] SUMMARY` label 維持不變（主模型兩種都會看到「not file content + targeted read 指引」）。

### 3.6 依賴與載入策略

- 新增 `.pi/extensions/shunt/package.json`（`"private": true`），dep：`@vscode/tree-sitter-wasm@0.3.1`（自含 web-tree-sitter runtime JS+wasm 與 17 個 grammar wasm；`tree-sitter-wasms@0.1.13` 棄用——其 2024 年旧格式 wasm 與新版 loader 不相容）。安裝：`npm i --prefix .pi/extensions/shunt`。node_modules 不進版本控制（本 repo 根非 git repo；README 注明）。
- **禁止 static import**：`index.ts` 對 `@vscode/tree-sitter-wasm` 一律 lazy `await import(...)`（module-level 記憶體化）。任一 import / `Parser.init()` / `Language.load` 失敗 → `announceOnce(ctx, "structure-engine-missing", ...)` + 該檔落下一分支。deps 缺席時 shunt 整體必須仍能載入與運作（v1 行為）。
- **S1 已定案的 import/API 形態**（2026-09-22 spike，Node 24 驗證 ALL PASS）：
  ```js
  const mod = await import("@vscode/tree-sitter-wasm");
  const { Parser, Language } = mod.default ?? mod;   // named exports 偵測不到，走 .default
  await Parser.init();                                // 一次，~40ms
  // wasm 路徑：<pkg>/wasm/tree-sitter-<lang>.wasm，以
  // createRequire(import.meta.url).resolve("@vscode/tree-sitter-wasm/package.json") 的 dirname 解析
  const lang = await Language.load(wasmPath);          // 只收 string | Uint8Array
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(code);
  ```
  - runtime API 與主流 web-tree-sitter 文件的差異：**node 位置是 `startPosition`/`endPosition`（無 `stopPosition`）**；**`hasError` 是 property 不是 method**。
  - parse 效能：311 行 .ts ≈ 41ms、302 行 .py ≈ 113ms（含 language load 一次成本）。

### 3.7 設定（`.pi/shunt.json`，新欄位皆 optional，舊檔完全相容）

```json
{
  "worker": "cliproxyapi/gemini-3.8-flash-high",
  "minLines": 350,
  "languages": ["ts","tsx","js","jsx","mjs","cjs","py","rs","go","sh"],
  "nonCode": "worker"
}
```

| 欄位 | 預設 | 說明 |
|---|---|---|
| `languages` | 上列十種 | 收縮 code 判定範圍；未列 extension → other |
| `nonCode` | `"worker"` | `"passthrough"` = 完全停用 LLM worker（other 文字一律放行） |

`normalizeConfig` 擴展：`languages` 必須是 string 陣列（否則取預設）；`nonCode` 只接受 `"worker"|"passthrough"`（否則取預設）。

### 3.8 Cache（in-memory，確定性引擎）

`Map<absPath\u0000mtimeMs\u0000size, renderedSummary>`，上限 64 entries（滿了整清）。只給確定性引擎（worker 路徑不 cache，維持 v1）。目的：同 session 重複整檔讀同一檔免重 parse。

## 4. 需求（編號）

- **R1** 新增純模組 `.pi/extensions/shunt/structure.ts`：不 import 任何 pi 套件、不 import `index.ts`；Node 可直接測。exports：`detectKind`、`buildCodeIndex`、`buildMarkdownOutline`、`buildDataProfile`、`renderStructure`（含 label）、`MAX_DETERMINISTIC_CHARS`。
- **R2** `detectKind` 依 §3.2 表；多重點號取最後 extension；無 extension → `other`；大小寫不敏感。
- **R3** `buildCodeIndex(buf, langId)`：web-tree-sitter 解析；§3.3 之內容（含完整簽名）、錯誤率門檻（>10% 行 → undefined）、backstop（400 entries / 40,000 chars）。
- **R4** markdown / csv / jsonl builders 依 §3.4；空檔與解析失敗 → undefined（jsonl 行失敗率 >10% → undefined；csv 空檔例外，rows=0 仍產出）。
- **R5** `index.ts` read rule 依 §3.1 判定樹接線；size cap 依 kind 分軌（code 2MB / md/csv/jsonl 20MB / worker 2MB）；`details.engine` 如 §3.1。
- **R6** 所有新失敗路徑 fail-open：engine 不可用、parse 失敗、builder undefined、config 新欄位缺——原結果原封不動，且 v1 的全部 pass-through 行為不變。
- **R7** dynamic import 策略依 §3.6；deps 缺席時 extension 正常載入（以 v1 worker 路徑或 passthrough 運作）。
- **R8** `rules.ts` 新增 `normalizeConfig` 對 `languages` / `nonCode` 的驗證（§3.7），舊 config 檔 parse 結果與 v1 完全一致。
- **R9** in-memory cache 依 §3.8（確定性引擎 only）。
- **R10** 文件：shunt README（v2 判定樹、新 config、**資料邊界聲明**：code/md/csv/jsonl 路徑完全本地、only `other`+worker 路徑送原文去 provider）、`docs/pi-extensions.md` shunt 節、根 `AGENTS.md` shunt 條目。

## 5. Slices

### S1 — deps + spike

- 檔案：`.pi/extensions/shunt/package.json`（新）、安裝 node_modules、`.pi/extensions/shunt/spike-structure.mjs`（新，保留為 dev script，README 注明）。
- 內容：`await import("web-tree-sitter")` + 自 `tree-sitter-wasms` 解析 typescript / python wasm → parse 一個 ≥300 行 fixture（.ts 與 .py）→ 印 top-level symbol 數與行號；測 tsx 雙 grammar 注入（成功/降級）；確認 Node 24 下的 interop 形態。
- 驗收：`node .pi/extensions/shunt/spike-structure.mjs` 對 fixture 輸出正確 symbol 數/行號；精確 import/wasm/tsx API 形態回填 spec §3.3、§3.6。
- 範圍外：任何 `index.ts` / `rules.ts` / 測試改動。

### S2 — structure.ts + 單元測試

- 檔案：`.pi/extensions/shunt/structure.ts`（新）、`.pi/extensions/shunt/test-shunt.mjs`（擴充）。
- 驗收：`node .pi/extensions/shunt/test-shunt.mjs` 全綠（現行 50 checks：selector 文法、攔截判定、`detectKind` 矩陣、code index 行號/簽名/backstop 截斷、md outline（nesting/無 heading/超額）、csv（空檔/header-only/樣本截斷）、jsonl（keys/失敗率）、render label 精確字串、`normalizeConfig` 新欄位、read hook 整合與 bash 偵測）；`grep -c "pi-coding-agent" structure.ts` = 0。
- 範圍外：`index.ts`、docs。

### S3 — hook 接線 + 整合測試 + docs

- 檔案：`.pi/extensions/shunt/index.ts`、`test-shunt.mjs`（整合節段）、`.pi/extensions/shunt/README.md`、`docs/pi-extensions.md`、根 `AGENTS.md`。
- 整合測試（沿用既有 fake-ctx + fixture dir 模式）：.ts fixture（≥350 行、含 class+function+imports）→ STRUCTURE label、斷言已知行號；.md / .csv / .jsonl fixture → 各引擎；.txt（other）→ worker 仍被呼叫；`nonCode:"passthrough"` → .txt 放行；engine 失效模擬（builder undefined）→ 落 worker；3MB .ts → 放行（code parse gate，不 worker 不 parse）；~2.6MB .md → 走 deterministic 不 worker；targeted read 一律放行（既有 case 覆蓋）。
- 驗收：`node .pi/extensions/shunt/test-shunt.mjs` 全綠；`node .pi/extensions/guard/test-guard.mjs`、`node .pi/extensions/shunt/../../extensions/skill-router/test-router.mjs`（如存在）不受影響；README/兩份 docs 與實作一致（新 config 欄位、判定樹、資料邊界）。

## 6. 測試矩陣（摘要）

| case | 期望 |
|---|---|
| 大 .ts 整檔 read | STRUCTURE（tree-sitter）、行號精確、完整簽名、≤400 entries backstop |
| 大 .ts targeted read（`:50-100` / offset+limit） | 放行（v1 不變） |
| 大 .md 整檔 read | STRUCTURE（markdown outline） |
| 大 .csv 整檔 read | STRUCTURE（csv profile） |
| 大 .jsonl 整檔 read | STRUCTURE（jsonl profile） |
| 大 .txt 整檔 read | worker（`nonCode:"worker"`）/ 放行（`"passthrough"`） |
| 3MB .ts | 放行（code parse gate 2MB） |
| .ts 內容為亂碼（error 行 >10%） | 落 worker / passthrough |
| web-tree-sitter import 失敗 | announceOnce + 落下一分支，extension 不掛 |
| 同檔二次整檔 read | 命中 cache，不重 parse |
| worker 失敗（既有） | 原結果（v1 不變） |

## 7. 風險與備選

- ~~CJS/ESM interop~~ **已驗證（S1）**：`await import("@vscode/tree-sitter-wasm")` 走 `mod.default` 取得 `{ Parser, Language }`，`Parser.init()` + `Language.load(path)` 全通；spike 在 `.pi/extensions/shunt/spike-structure.mjs`（保留為 dev script）。
- ~~grammar 可用性~~ **已驗證（S1）**：`@vscode/tree-sitter-wasm@0.3.1` 含本 spec 預設集全數（typescript、tsx、javascript、python、rust、go、bash），tsx 可獨立 load；`tree-sitter-wasms@0.1.13` 舊格式 wasm 與新 loader 不相容（已棄用）。
- **剩餘風險**：各語言 grammar 的 node type 差異（S2 以 per-language fixture 斷言防漂）；大檔 buffer（`safeRead` 整檔讀入，code 2MB／md/csv/jsonl 20MB 上限內可接受，不做 streaming parse）。
- **file buffer**：`safeRead` 現為整檔讀入；code 2MB／md/csv/jsonl 20MB 上限下可接受，不做 streaming parse（tree-sitter 需完整 buffer）。
