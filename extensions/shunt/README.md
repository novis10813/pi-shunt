# shunt

把「大檔整檔讀取」的內容卸載出主模型 context。code 與 markdown 走本地確定性引擎產出結構索引，不呼叫任何 model，檔案不出機。

## 行為（`tool_result(read)` hook，shunt 不註冊任何 tool）

`read` 成功執行後，對非 targeted 的整檔讀取（無 offset/limit、無 `:range` selector）且超過 `minLines` 行的檔案，依 extension 決定引擎：

| kind | 引擎 | size cap | 輸出 |
|---|---|---|---|
| code（`ts,tsx,js,jsx,mjs,cjs,py,rs,go,sh`，可經 `languages` 收縮） | tree-sitter | 1,000,000 bytes | imports + top-level symbols（完整簽名）+ 一層 class/struct members，1-based 行號 |
| `md,markdown` | heading outline | 20,000,000 bytes | `## Heading [line]`（fence-aware，depth ≤ 6） |

- 成功時結果替換為 `[shunt] STRUCTURE — not file content. "<path>" (<N> lines). Deterministic index (engine: …)` 加索引，並指引用 targeted read 取精確內容。
- `details`：`{ shunt: true, engine: "tree-sitter"|"markdown", lines }`。
- code 的 1MB cap 是因為 tree-sitter WASM parse 是同步執行，大檔會卡住 session。

## 放行（原結果原封不動）

Targeted read、小檔（≤`minLines`）、其他副檔名、image、binary、不存在的檔案、read 出錯、超過 size cap、引擎失敗（parse 錯誤行 >10%、沒有 heading、tree-sitter 無法載入）。

## 設定（`<cwd>/.pi/shunt.json`）

```json
{
	"minLines": 350,
	"languages": ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "sh"]
}
```

| 欄位 | 預設 | 說明 |
|---|---|---|
| `minLines` | `350` | 超過此行數的整檔讀取才會被攔截 |
| `languages` | 上列十種 | 收縮 code 判定範圍，只收縮不擴充 grammar 集 |

沒有 shunt.json 或解析失敗時 shunt 停用。

## 限界

- kind 只依 extension 判定，不看內容。selector 判定 mirror read-selector extension，是字串比對。
- 索引不是原文。要編輯或引用時用 targeted read，索引的行號就是為此產出的。
- code 索引最多 400 筆，渲染總長最多 40,000 chars。markdown 最多 100 個 heading。
- 索引有 in-memory LRU cache（64 entries，key = path + mtime + size + 設定）。

## 驗證

```bash
node extensions/shunt/test-shunt.mjs
```
