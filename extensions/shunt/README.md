# shunt

Token-routing extension for the pi coding agent。把「大檔整檔讀取」的內容卸載出主模型 context：code / markdown / csv / jsonl 走**本地確定性引擎**產出結構索引（不呼叫任何 model、檔案不出機），其餘文字檔 fallback 到便宜的 worker model 摘要。

## 行為

### read 規則（`tool_result` hook，shunt 不註冊任何 tool）

`read` 成功執行後，對「非 targeted 的整檔讀取」（無 offset/limit、無 `:range` selector）且 >`minLines` 行，依 extension 決定引擎：

| kind（依 extension） | 引擎 | size cap | 輸出 |
|---|---|---|---|
| code（`ts,tsx,js,jsx,mjs,cjs,py,rs,go,sh`，可經 `languages` 收縮） | tree-sitter（本地） | 2,000,000 bytes | imports + top-level symbols（函式/class 附完整簽名：params＋型別＋回傳型別，不截斷）+ 一層 class/struct members（含型別），精確 1-based 行號 |
| `md,markdown` | heading outline（本地） | 20,000,000 bytes | `## Heading [line]`（fence-aware，depth ≤ 6） |
| `csv,tsv` | profile（本地） | 20,000,000 bytes | rows/columns/欄名（≤20）+ 前 3 行樣本（行首截 80 chars） |
| `jsonl,ndjson` | profile（本地） | 20,000,000 bytes | rows + 前 100 行 keys（≤20）+ 前 2 行樣本（截 120 chars） |
| 其餘（含 `.json`） | LLM worker（預設 `cliproxyapi/gemini-3.8-flash-high`，`reasoningEffort: low`）或放行（`nonCode: "passthrough"`） | 2,000,000 bytes | `[shunt] SUMMARY` 摘要 |

- code 的 1 MB cap 限制同步 tree-sitter WASM parse 的輸入大小，並非執行時間保證：實測約 990,000 bytes、8,000 個 TypeScript functions 的索引仍需 1.40 秒（單次量測，依機器與程式形狀而異）。>1 MB 的 code 檔直接放行（不讀檔、不 parse、不落 worker）。md/csv/jsonl 是逐行 profile、無 parse stall，維持 20MB。
- 確定性引擎成功 → 結果替換為 `[shunt] STRUCTURE — not file content. "<path>" (<N> lines). Deterministic index (engine: …)` label + 索引，並指引用 targeted read 取精確內容。
- 確定性引擎失敗（parse 錯誤率 >10%、無 heading、jsonl 行失敗率 >10%、engine 不可用）→ 原結果放行，不呼叫 worker。所有失敗一律 fail-open：原結果原封不動。
- 判斷前先 `stat`（kind 只依 extension 判定，不需讀檔）：缺失／非 regular file／超過對應 size cap 直接放行。
- `details`：`{ shunt: true, engine: "tree-sitter"|"markdown"|"csv"|"jsonl"|"worker", lines }`（worker 路徑另帶 `worker` 欄位，與 v1 相容）。
- 與任何 `read` override（含全域 `read-selector` extension）疊加無衝突；selector 語法判定 mirror read-selector。

### bash 規則（`tool_call` hook）

`cat|head|tail|less|more` 對大檔直接擋下，reason 指向 read tool（並告知大檔 read 會回結構索引）。反斜續行先合併；命令依 `;`、`&&`、`||`、換行切分；每段 pipeline 只看最後一個 segment。只有 stdout 重定向到檔案（`>`、`>>`）放行；stderr 重定向（`2>`、`2>&1`）、`>&n` dup、以及 `< f` stdin 來源**都不算**（stdout 仍會 dump／檔名仍會被 probe）；subshell 包住（`(cat f)`）、`xargs`/`sudo` 前綴、backslash 續行的讀取仍會被偵測；黏連 redirect（`cat<file`）亦然。引號參數 tokenized 為單一 token（`cat "big file.txt"`、甚至被引號包住的命令名都認得出）；**尾部 segment 是 unbounded reader**（`cat`/`less`/`more`，或超標自 stdin 讀的 `head`/`tail`）時，前段 segment 的檔案參數也成 candidate（`cat big.txt | cat`）；command substitution（`$(…)`/backtick，一層）的輸出經父命令進 context，同樣掃描（`echo "$(cat big.txt)"`）。`head`/`tail` 無明確行數（預設 10 行）可放行；明確行數須依符號判定：`head -n N`/`+N` 取前 N 行（N ≤ `minLines` 才放行）、`head -n -N` 除末 N 行外全部（不放行）；`tail -n N`/`-N` 取末 N 行（N ≤ `minLines` 才放行）、`tail -n +N` 從第 N 行到 EOF（**一律不放行**，與 N 大小無關：`tail -n +400` 對 10,000 行檔實測輸出 9,601 行）。明確 bytes：`head -c N`/`tail -c N` 與 `tail -c -N` 須 N ≤ `minLines×80`；`head -c -N` 除末 N bytes 外全部、`tail -c +N` 從第 N byte 到 EOF（`tail -c +500` 對 2,000 bytes 檔實測 1,501 bytes），皆不視為 bounded。黏連形式（`-n400`、`-n+400`、`-c+500`）與空白分隔形式同判。行數與 bytes 皆未超標才放行。行數以 streaming probe 統計（數到 `minLines+1` 行即提前中斷，記憶體有界）；中斷時 reason 報下界 `N+ lines`。

## 放行（hook 回傳 undefined，等同沒有 shunt）

Targeted read（offset/limit 或 `:range` selector）、小檔（≤`minLines`）、image、binary、不存在檔、read 出錯、超過 size cap、cwd 外的檔案（worker 路徑 egress 邊界：原文不出機只限專案內）、`nonCode: "passthrough"` 的 other 文字、worker 不可用/逾時/失敗——原結果原封不動（fail open）。

## Read 診斷（仍由 shunt 單獨改寫 tool output）

shunt 同一個 `tool_result(read)` handler 於形成最終結果後，依 `.pi/diagnostics.json`（缺檔時使用預設）和本機 CLI linter 裝飾 code 讀取：tree-sitter 索引附 `[shunt] DIAGNOSTICS` 段，精確對得上原文的小檔或單範圍 targeted read 在該行之後標註。read 工具的兩款 continuation banner（`[N more lines…]` 與 50KB/行數上限的 `[Showing lines A-B of C…]`）識別後暫存、註記後原樣接回；其他非原文標記、不確定行號、多範圍讀、worker 摘要與非 code 索引均不加註。file-level（line 0）診斷（如 biome format）前置顯示於 targeted 註記開頭。既有純索引快取不包含診斷；每次 read 重新 lint，避免 linter 設定更新後顯示舊結果。`shunt.json` 缺席時仍能處理小檔／targeted 原文的診斷；缺少 lint CLI 則原 read 輸出不變。

共用純 linter 模組在 `shared/diagnostics/`，post-turn 的 ripple extension 使用同一模組但從不改寫 tool output。CLI 缺席或失敗即 fail-open。custom command 只允許 `biome`/`ruff`/`shellcheck` 三個 binary，且拒絕會改檔的旗標（`--write`、`--fix`、`--fix-only`、`--fix-all`、`--apply`、`--apply-unsafe`、`--unsafe*`、`--unsafe-fixes`、`--add-noqa`；`--no-fix` 可）——診斷在 read／turn_end 自動觸發，不得成為不經 agent 決策的 read→write 路徑（allowlist；其他 binary 的設定使 diagnostics 整體停用，防 per-project 設定檔成為任意程式執行）。Biome 解析 v1（`range`/`description`/`rule.name`，0-based）與 v2（`location`/`category`/`message`，1-based、`line:0` 為 file-level）兩版 JSON schema；ruff 與 Biome v2 已 live 驗證（2026-07-19），shellcheck 尚未安裝（缺席時該語言 fail-open）。規格：`docs/dev/read_diagnostics_ripple_spec.md`。

## 資料邊界

- **code / markdown / csv / jsonl 路徑完全本地**：tree-sitter parse 與 profile 都發生在本機 Node process，檔案內容**不送任何外部 provider**。
- **only `other` 文字檔 + `nonCode: "worker"` 路徑**會把檔案原文送往 worker model 的 provider。不需要這條邊界時，設 `"nonCode": "passthrough"` 即完全停用 LLM 路徑。

## 設定（`<cwd>/.pi/shunt.json`，新欄位皆 optional）

```json
{
	"worker": "cliproxyapi/gemini-3.8-flash-high",
	"minLines": 350,
	"languages": ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "sh"],
	"nonCode": "worker"
}
```

| 欄位 | 預設 | 說明 |
|---|---|---|
| `worker` | `cliproxyapi/gemini-3.8-flash-high` | `"provider/modelId"`；須為 `ctx.modelRegistry` 已配置 auth 的 model |
| `minLines` | `350` | 超過此行數的整檔讀取才會被攔截 |
| `languages` | 上列十種 | 收縮 code 判定範圍（未列 extension → other）；只收縮不擴充 grammar 集 |
| `nonCode` | `"worker"` | `"passthrough"` = 其他大文字檔一律放行（完全停用 LLM worker） |

沒有 shunt.json 或解析失敗 → shunt 靜默停用。

## 依賴

- 根 `package.json` 唯一 dependency：`@vscode/tree-sitter-wasm@0.3.1`（自含 web-tree-sitter runtime 與 7 個 grammar wasm：typescript、tsx、javascript、python、rust、go、bash）。依賴宣告在 repo 根的 `package.json`，`pi install` 時自動 `npm install`；node_modules 不進版本控制。
- 載入策略：一律 lazy `await import`；deps 缺席或 engine 初始化失敗 → 一次性 warning（`announceOnce`）+ 該檔落下一分支，shunt 整體仍正常運作（v1 行為）。
- `spike-structure.mjs` 是 S1 的 dev script（grammar/interop 驗證），非 extension 載入路徑。

## 限界

- **Heuristic，非沙箱**：bash 偵測是字串 pattern（同 guard），不是 shell parser；kind 判定是 extension，不看內容。
- **stat→read 的 TOCTOU**：檔在 stat 與 read 之間被並行寫入時可能超過 size cap（接受；read 上限 20MB，Node 可承受）。
- **索引非精確內容**：要編輯或引用原文時用 targeted read（索引裡的行號就是為這個用途產出的）。code 索引 backstop ≤400 筆（多餘以 `… +N more entries` 收）、渲染總長 ≤40,000 chars（簽名永不逐筆截斷，只有這個總量 backstop）；md ≤100 個 heading。
- **不可 delegate reasoning**：shunt 只處理 I/O 型讀取，不處理理解/除錯/架構判斷。
- Worker 呼叫 60s 逾時、可被 Esc（`ctx.signal`）中斷。確定性引擎結果有 in-memory cache（≤64 entries，key = path+mtime+size+minLines/languages/nonCode；命中時在 stat 後直接回傳，免重讀檔與重 parse），同 session 重複整檔讀免重複 I/O。非 code 文字的 worker 摘要另有一份 LRU（≤64 entries，key = path+mtime+size+worker+minLines，只存成功結果；失敗不入 cache），重讀未變動的檔不重複遠端 LLM 呼叫。**Lint 結果刻意不 cache**（linter 設定改動不一定改 source mtime；測試「index cache 不得含 stale findings」為不變式），每次 read 仍會跑一次 linter。

## 驗證

```bash
node extensions/shunt/test-shunt.mjs     # 79 checks（含整合測試）
node extensions/shunt/spike-structure.mjs # S1 dev script
```

涵蓋：selector 語法（mirror read-selector）、攔截判定、行號前綴（numberLines）、detectKind/grammar 映射、code index（ts/py/rs/go/bash 行號、members、完整簽名、python decorated defs 與 bare import、go interface members 與 backtick import、錯誤率門檻、400 筆 backstop）、md/csv/jsonl profile（空檔、欄數/keys 上限、樣本截斷）、STRUCTURE label 精確字串、40k char backstop、read hook 各引擎整合（含 3MB .ts 逾 code parse gate 放行、~2.6MB .md 走 deterministic、garbage code 檔放行、cache、`nonCode: "passthrough"`）、worker 失敗回退、bash 偵測（含引號 token、`$(…)`/backtick substitution、unbounded 尾部 reader、cwd 外 egress 邊界）與 streaming probe early exit。
