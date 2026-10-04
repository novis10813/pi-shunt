# Shunt Read Diagnostics 與 Ripple Post-turn Feedback Implementation Spec

**Goal：**依 agent 資料流而非 lint 功能名稱劃分責任：`shunt` 是唯一可改寫 `read` tool result 的 extension；`ripple` 只在下一次模型請求提供編輯後診斷增量與 rename 提醒；兩者共用中立的純 linter 模組。**本文件只規劃，未授權實作。**

**架構：** `.pi/shared/diagnostics/{config,linters}.ts` 不註冊 hook、不 import pi；`.pi/extensions/shunt/index.ts` 在原有 `tool_result(read)` handler 中把診斷加入**最後回傳**的樹狀索引或原文；`.pi/extensions/ripple/index.ts` 在 `tool_call`、`tool_result`、`turn_end` 管理檔案變動並於回合結束寫入持久化 `custom_message` entry，供下一輪請求看到。兩個 extension 不互相 import、不解析彼此的輸出；**extension 載入順序無關緊要**。共同配置為 `<cwd>/.pi/diagnostics.json`（不建立預設檔）；ripple 專屬配置為 `<cwd>/.pi/ripple.json`。

**全域約束：**零新 agent tool、零新 npm/root build 依賴、不可改 guard/skill-router/self-compact、不可將完整原文送往新 model（worker 路徑另限 cwd 內檔案：cwd 外直接放行）、不可 auto-install linter；lint/git 失敗 fail-open。`shunt` 現行大檔摘要、索引、bash 防護與快取行為在診斷關閉／缺席時逐字不變。`index.ts` 只管 dispatch 與 session 狀態，解析與格式化留純模組。

**Grounding Note：**現有 `shunt` 以 `tool_result(read)` 在 full read、符合閾值時回傳 `{content, details:{shunt:true,engine,lines}}`，targeted read 直接放行，設定缺席會停用摘要【已驗證：`.pi/extensions/shunt/index.ts:212-316`、`rules.ts:113-139`】；tree-sitter 索引命中快取時直接回傳快取文字【已驗證：`shunt/index.ts:242-252`】。`read` 原文無行號前綴（先前 pi smoke）；測試使用 Node 自帶 test script 與 `pi-alias.mjs` 載入 index.ts【已驗證：`shunt/test-shunt.mjs`、`shunt/pi-alias.mjs`】。pi 對同一目錄內 extension 無排序保證（`dist/core/extensions/loader.js` 的 `fs.readdirSync` 無 sort）；先前 `message_end` spike 雖可見 shunt 的輸出，**本方案刻意不用它作跨 extension read 鏈**。本機 biome（2.5.14）與 ruff（0.16.9）已安裝並 live 驗證（2026-07-19）；shellcheck 缺席，其 schema 須標 SKIP，不能宣稱已驗證。

## 1. 範圍與不做

**In-scope：**（1）單檔 CLI linter 與統一 Diag 資料形狀；（2）shunt 對 full-read index 附段、對未被摘要的單範圍 read 行內註記；（3）ripple 僅報當輪成功 edit/write 引起的新增 lint 及 git rename 遺留引用；（4）可選的成效量測、文件、測試。

**Not-Doing：**LSP daemon、same-turn 主動續輪、bash 改檔偵測、機械式 rename、rs/go 預設 linter、多範圍 selector 的行內註記、對非 code/worker summary 附 lint、跨 extension hook 協議。理由：維持讀取與回合後提示兩條流程各自封閉，避免隱性順序／高成本擴張。停用 `shunt.json` 的摘要功能**不會停用** diagnostics；ripple 可單獨停用。

## 2. Requirements & Contracts

### REQ-1：共用純模組提供明確的 lint 成功／不可用區別【新設計】

- 新建 `.pi/shared/diagnostics/config.ts`、`linters.ts`；僅用 Node built-ins。`loadDiagnosticsConfig(cwd): DiagnosticsConfig | null`：缺檔用預設；無效 JSON/欄位或 `enabled:false` → null。每次呼叫按 cwd 讀取（可在單回合內快取但改設定後下回合須生效）。預設：`languages=[ts,tsx,js,jsx,mjs,cjs,py,sh,bash]`、`timeoutMs=10000`、`maxFindings=20`、`commands` 可依 extension 覆寫；command 只接受 whitespace 分隔的固定 tokens 與恰一個 `{files}`，不經 shell；不支援空白的 executable path 或自訂 shell quoting；binary 限 `biome`/`ruff`/`shellcheck`（allowlist）：per-project 的 `commands` 覆寫若是其他 binary 即整體停用 diagnostics，防設定檔成為任意程式執行。
- 【新設計】`Diag={file:absolutePath,line:1-based,col:1-based（未知=0）,severity:"error"|"warning"|"info",rule:string,message:單行字串}`；`LintResult={kind:"ok",diagnostics:Diag[]}|{kind:"unavailable"}`。`lintFile(absPath,cfg,executor?):Promise<LintResult>`。正常解析得到空陣列是 `ok`，ENOENT／不可解析／逾時是 `unavailable`；消費端不得把 unavailable 當作已修復或零診斷快照。linter 回報 findings 的非零 exit code 只要 stdout JSON 可解析也算 ok。
- 每檔一次 `execFile(binary,args,{timeout,maxBuffer})`；檔案為絕對路徑，禁止 shell；只 lint regular file，限制大小（預設 2 MB），上限超過回 unavailable。**本版 lint 結果不跨 read/turn 快取**：linter 設定（ruff.toml、biome.json 等）可能變更而原檔 mtime 不變，單靠檔案 stat 的 cache 會誤報；兩 extension 每次請求各跑一次 linter。shunt 原有結構索引快取保留且只保存純索引，診斷每次另跑；ripple 修改前／後各跑一次，以避免沿用過期結果。
- 預設 command：JS/TS `biome check --reporter=json {files}`；Python `ruff check --output-format json --no-fix {files}`；Shell `shellcheck -f json {files}`。ruff JSON array 的 `location.row/column`、`code/message`；shellcheck JSON array 的 `line/column`、`code/level/message`；Biome 同時支援 v1 與 v2 兩版 JSON schema：v1 `{diagnostics:[{range:{start:{line,character}},severity,description,rule:{name}}]}`（0-based 座標加一）、v2 `{diagnostics:[{location:{start:{line,column}},severity,category,message}]}`（1-based 座標直接採用；`line:0` 為 file-level sentinel，保留為 0）；解析器以 `location ?? range`、`category ?? rule.name`、`message ?? description` 取欄位，壞結構丟棄該筆，訊息換行改空白。ruff 與 Biome v2 schema 已 live 驗證（2026-07-19，本機 ruff 0.16.9 / biome 2.5.14）；shellcheck 未安裝、仍 SKIP。指令選項或版本 schema 不符時只修共享模組，不散改 extension。

  Fixture（【已 live 驗證：ruff 與 Biome v2，2026-07-19；shellcheck SKIP】；Biome 樣本為 v1 schema，`test-diagnostics.mjs` 另含 v2 `location`/`category`/`message` 樣本）：
  - Ruff 輸入 `[{"code":"F401","filename":"/abs/bad.py","location":{"row":1,"column":8},"message":"unused import"}]` → `[{file:"/abs/bad.py",line:1,col:8,severity:"warning",rule:"F401",message:"unused import"}]`。
  - ShellCheck 輸入 `[{"code":2046,"line":2,"column":3,"level":"style","message":"Quote this","file":"/abs/bad.sh"}]` → `[{file:"/abs/bad.sh",line:2,col:3,severity:"info",rule:"SC2046",message:"Quote this"}]`（亦容許 `path` 欄位；只 lint 單檔時以呼叫路徑作絕對 file）。
  - Biome 輸入 `{"diagnostics":[{"range":{"start":{"line":0,"character":5}},"severity":"error","description":"Unused value","rule":{"name":"noUnusedVariables"}}]}` → `[{file:"/abs/bad.ts",line:1,col:6,severity:"error",rule:"noUnusedVariables",message:"Unused value"}]`。若 live schema 使用 offset/span 而非 line/character，先修解析器與 fixture 才放行，不能把有效 lint 結果當作 0 findings。

### REQ-2：shunt 在單一 read handler 內交付兩種診斷且不污染原有索引快取【新設計】

- 擴充 `.pi/extensions/shunt/index.ts`，read 成功、文字區塊非空、檔案可定位且 diagnostics config 啟用時，解析路徑（沿用 `stripPathSelector`【已驗證：`shunt/rules.ts:88-112`】），路徑 extension 需在 diagnostics.languages；source 命中圖片／錯誤／非 text、無效 path、lint unavailable／0 findings → 原樣回傳。**diagnostics 與 shunt.json 分別啟用**：即使缺 `shunt.json` 仍可針對小檔或 targeted 原文標註；被 shunt 摘要的非 code 或 worker 路徑不處理 lint。
- `tool_result(read)` 只在**同一個 shunt handler**形成最終輸出；原有 early return 需重整成統一的「shunt 決定 → diagnostics 裝飾」管線（可用內部 `decorate` helper），確保 cache hit、首次索引、小檔、targeted、shunt config 缺席都進對應分支；保留原本失敗回退。**原有 cache 只保存未附診斷的索引**，每次 read 回傳時用當下 lint 結果附加；lint 不可改變 shunt 的是否攔截判斷。
- Mode 1：僅 `details.shunt===true && details.engine==="tree-sitter"`，將 `\n[shunt] DIAGNOSTICS (N):\n  12:6 error [noUnusedVariables] ...` 附於索引末尾（上限 maxFindings，餘數 `  … +N more`）；保留原 details、不修改 worker/markdown/csv/jsonl 輸出。**即便 code 的 tree-sitter 解析失敗走 worker，也不對 worker summary 附段**。
- Mode 2：當最終輸出為 read 的**原文**（非任一 shunt summary/index），小檔全檔或單一 range read 才依結果行號加註；支援 `offset/limit`、`:N`、`:N-M`、`:N+K`、`:raw` 單獨全檔；`multi-range`、不明 selector 保守放行。read 工具的兩款 continuation banner——`[N more lines in file. Use offset=X to continue.]` 與 50KB/行數上限裁切的 `[Showing lines A-B of C. Use offset=X to continue.]`【已驗證：pi-coding-agent dist `core/tools/read.ts`】——識別後暫存、對剩餘原文做 exact-slice 驗證與註記、再原樣接回。**單一 bounded selector 的結果起始行不是 N**：全域 read-selector 對 `:N-M`、`:N+K` 先加 1 行前文與 3 行後文，實際首行為 `max(1,N-1)`；`:N`/`:N-` 只加 1 行前文；`offset` 直接用 offset，selector 與 offset 同時存在時 selector 優先【已驗證：`~/.pi/agent/extensions/read-selector.ts:310-326,465-471`】。`read-selector` 會先檢查是否有字面上帶冒號的檔名；若原路徑本身存在則按字面檔名處理，shunt 必須先檢查原路徑存在再剝 selector；無法確認時放行不註記【已驗證：`read-selector.ts:431-452`】。上述 banner 之外的其他非檔案原文標記放行，不以提示行數推算位置。file-level（line 0）診斷不屬任何行，targeted 註記時前置顯示於開頭。例：`import os\n` 加 line 1 F401 → `import os\n  ⚠ line 1 [F401] unused import\n`；行號超出回傳文字範圍的診斷丟棄。空 diagnostics 或執行失敗**逐字不變**；改寫必須保留原 details、images 與其他 text blocks（不丟資料）。
- 新純模組 `.pi/extensions/shunt/diagnostic-render.ts` 實作索引段、範圍推算、行內渲染；不得 import pi。shunt 測試增加 cache hit 後 lint 更新、缺 shunt config 仍註記、worker 不附註、selector、多個內容塊及既有 56 checks 迴歸。

### REQ-3：ripple 用「修改前快照」計算新診斷而非猜測首見基線【新設計】

- 新 extension `.pi/extensions/ripple/index.ts`，不攔截、不替換任何 tool output。`tool_call(edit/write)` 依 `event.input.path` 在工具執行前對可 lint 的**既存檔**先取得 pre-edit lint 基線（上限 20 個 touched 檔／turn）；若 `write` 目標檔在修改前明確 ENOENT，標記 `new-file` 基線為成功的空集合（不呼叫缺檔 linter）；其他 stat／預檢 unavailable 不能假稱為新檔或「新增」，該檔這輪跳過 delta。後續 `tool_result(edit/write)` **成功**才將檔列入本輪 touched。若某次 edit/write 失敗或被 guard 擋下、沒有成功結果，不產生 touched；同一 turn 重複修改同檔沿用首個有效 pre-edit 基線。為避免外掛順序影響，基線讀取只使用原有磁碟檔，不依賴 shunt 的輸出或 guard 結果；若 tool_call 未被呼叫則本輪不可計 delta，fail-open。
- `turn_end` 對成功 touched 檔重新 lint，既存檔僅雙方 `kind:"ok"` 時計算 `K_after \ K_before`；`new-file` 則用成功空集合當修改前基線。診斷識別 key `K={file\0line\0rule}`（同 key 訊息／嚴重度更動不視為新增），每檔最多 20、總計最多 20。write 新檔把全部發現視為新增（與舊規格不同：本輪建立的診斷確屬本輪引入）；若嫌噪音，後續依量測調整，不靜默定義為既有。`turn_end` 只存 pending，不強制 `continue:true`；未再有模型請求時當輪不會看到提醒。
- `turn_end` 有新增時回傳 `{entries:[{type:"custom_message",customType:"ripple-delta",content,display:false}]}`（無 `continue:true`）；由 pi journal 持久化，下一次模型請求自然讀到，跨 `pi -p --session-id` process 亦有效【已驗證：真實雙輪 smoke `ripple=yes[F841]`】。`context` 只過濾上一個 user turn 以前的舊 `ripple-delta`／`ripple-rename`，保留最新提示供下一輪參考（不改 journal）；無新增／lint unavailable 時不寫 entry；每輪最多一筆 delta、無重複訊息。純函式算差集／格式化放 `.pi/extensions/ripple/delta.ts`。例：【新設計】`[ripple] POST-TURN LINT: 1 new diagnostic\n  /abs/a.py:7 warning [F841] unused variable`。

### REQ-4：rename 提示只敘述證據，不自動修改檔案【新設計】

- `.pi/extensions/ripple/rename.ts` 在 `turn_end` 對 git repo 偵測 unstaged **與 staged** rename（`git diff --find-renames --name-status --diff-filter=R` 和 `git diff --cached --find-renames --name-status --diff-filter=R`，去重，5s timeout，上限 5 筆）；git 呼叫一律帶 `-c core.fsmonitor=`，diff 另帶 `--no-ext-diff`（subcommand 選項），防 hostile repo 的 fsmonitor/ext-diff 設定被執行；`git grep -n -F -- <old relative path>`、old basename（含副檔名）及去副檔名 basename 掃描 tracked 工作樹，最多 20 行，排除 old/new 文件自身與重複匹配。只要仍有參照才產生 pendingRename；非 repo／git 不在／指令失敗／找不到引用 → 不提示。`git diff` 不會看見未追蹤目的檔：純 `mv a b` 且未 `git add b` 的 rename **不在本版偵測範圍**；unstaged rename 只有 Git 辨識到索引與工作樹間的 tracked 配對時才能回報，測試依實際 git diff 語意建立 fixture，不承諾純 mv 一定能被察覺。路徑安全由 execFile argv 保證，避免用 shell。
- 同在 `turn_end` 以 `custom_message` entry（`customType:"ripple-rename"`）持久化；文字指出 `old → new`、檔:行:引用片段（單行裁切）、建議核對引用；由 agent 自決是否詢問使用者，extension 不自行改寫、不註冊 tool。已 stage rename 的實際引用在工作樹也須被找到；以 tmp git repo fixture 實測 staged/unstaged、duplicate 與非 repo。

### REQ-5：設定與量測各自獨立，更新現有文件【新設計】

- `.pi/diagnostics.json` 可選配置共享 lint；壞設定停用 lint 但不能停用 shunt 摘要、ripple rename。`.pi/ripple.json` 可選：`{"enabled":true,"rename":true,"measure":false}`；壞設定停用 ripple，shunt read diagnostics 仍正常。
- `measure:true` 時 ripple 每輪追加 JSONL 到 `~/.local/state/ripple/measure.log`（mkdir、append 失敗靜默）：`{"ts":"...","touched":2,"delta_new":1,"delta_survived":0,"renames":1}`；delta_survived 僅與**前一輪曾報**的 key 比對本輪可 lint 且有成功結果者，不可 lint 時記 `null`（不是 0）。不含檔案路徑／原文。量測只能幫助評估 F1b 去留，**不把欠缺下一輪請求等同失敗**。
- 更新 `.pi/extensions/shunt/README.md`、新 `.pi/extensions/ripple/README.md`、`docs/pi-extensions.md`、根 `AGENTS.md` 的索引／驗證；原 `docs/dev/t-diag_spec.md` 已移除，本文件為唯一規格。

## 3. 可獨立驗收的切片（依序，仍需使用者另行授權實作）

### Slice 1：中立共享 lint 核心（REQ-1、REQ-5 的共享設定）
- **Create/Test：** `.pi/shared/diagnostics/config.ts`、`linters.ts`、`test-diagnostics.mjs`。**Consumes：** Node built-ins；無 extension import。**Produces：** `Diag`、`LintResult`、`loadDiagnosticsConfig`、`lintFile`【新設計：REQ-1】。
- **Fixture：** 三種 JSON 字串、fake execFile（lint exit 1＋有效 JSON、ENOENT、逾時、亂碼）、臨時檔改 mtime、無效配置；`command -v biome ruff shellcheck`，存在才跑最小 live schema 並更新標記，否則 SKIP。
- **Steps：** 先寫 parser/錯誤區分／不跨次快取等斷言並確認紅；實作後確認綠；再測檔案或 linter config 改動後重跑、maxBuffer/timeout fail-open。**Verify：** `node .pi/shared/diagnostics/test-diagnostics.mjs`。**Commit boundary：** shared lint core。

### Slice 2：shunt 唯一 read-output 擁有者（REQ-2）
- **Create：** `.pi/extensions/shunt/diagnostic-render.ts`。**Modify/Test：** `.pi/extensions/shunt/index.ts`、`.pi/extensions/shunt/test-shunt.mjs`。**Consumes：** Slice 1 的 lint/config，既有 `decideIntercept`、`renderStructure`、`stripPathSelector`【已驗證：`shunt/rules.ts`、`structure.ts`】。**Produces：** 同一 `tool_result(read)` handler 的兩個 mode【新設計】。
- **Fixture：** 現有 shunt integration runner + fake linter command（不依賴安裝），大 code index/cache hit、小檔、targeted read（驗證前文行號 `:50-100→49` 與字面含冒號檔名）、worker summary、shunt config 缺席、非文字/失敗。先寫精確字串與原樣放行測試確認紅；接 dispatcher＋純 renderer 使綠；驗證未增加 hook/tool 註冊。**Verify：** `node .pi/extensions/shunt/test-shunt.mjs && node .pi/shared/diagnostics/test-diagnostics.mjs`。**Commit boundary：** shunt read annotations。

### Slice 3：ripple 診斷 delta（REQ-3）
- **Create/Test：** `.pi/extensions/ripple/index.ts`、`.pi/extensions/ripple/delta.ts`、`.pi/extensions/ripple/test-ripple.mjs`；需要時建立本目錄 `pi-alias.mjs`（同 shunt 的 alias 用法【已驗證：`shunt/pi-alias.mjs`】）。**Consumes：** Slice 1 的 lint/config；pi edit/write/tool_call/turn_end hooks。**Produces：** pre/post 基線與 turn_end journal entry【新設計】。
- **Fixture：** tmp dir 中既存 .py 與新檔；fake tool events；successful edit、blocked/failed edit、unavailable pre/post、多次改同檔、只修復診斷、全程零 tool result 替換。先紅→實作→綠；本機 linter 無安裝則用固定輸出 fake CLI 驗證 `pi -p --session-id` 跨 process 雙輪（真實 provider），linter 有安裝時另做 live schema 驗證。**Verify：** `node .pi/extensions/ripple/test-ripple.mjs`。**Commit boundary：** ripple turn-end delta。

### Slice 4：ripple rename nudge 與可選量測（REQ-4、REQ-5）
- **Create：** `.pi/extensions/ripple/rename.ts`。**Modify/Test：** `.pi/extensions/ripple/index.ts`、`.pi/extensions/ripple/test-ripple.mjs`。**Consumes：** Slice 3 turn_end 持久化 entry 管線。**Produces：** staged/unstaged rename evidence、量測 JSONL【新設計】。
- **Fixture：** tmp git repo（git init、commit、git mv 後 staged 一例，以及 `git diff` 實際能辨識的 tracked unstaged rename 一例；純 mv 未 add 的目的檔應 SKIP；引用含無副檔名 import）、非 repo、fake timeout；量測無檔案內容且 measure:false 不建立檔案。先紅→實作→綠。**Verify：** `node .pi/extensions/ripple/test-ripple.mjs`。**Commit boundary：** ripple rename/measure。

### Slice 5：文件、真實交付 smoke 與總迴歸（REQ-2～REQ-5）
- **Create：** `.pi/extensions/ripple/README.md`。**Modify：** `.pi/extensions/shunt/README.md`、`docs/pi-extensions.md`、`AGENTS.md`；必要測試調整只限 Slice 1～4 既列的測試檔。**Consumes：** 前四片所有介面。**Produces：** 兩流程使用方式與失效邊界可獨立閱讀的文件。
- **Fixture：** 在本 repo 暫時建立 >350 行 code 檔及小 code 檔（驗證後刪除）；pi 模型用 `cliproxyapi/gemini-3.1-flash-lite`【已驗證：`AGENTS.md`】。檢查 model 的大檔 `STRUCTURE` 標頭、可用 linter 下的診斷附段/行內註記；無 linter 時 live lint SKIP，fixture 整合測試仍必須通過。ripple turn_end entry 使用同 session 跨 process 雙輪 smoke（`--session-id`；需確實檢查模型看到 delta 而非只看到舊訊息）。**Verify：** `node .pi/extensions/guard/test-guard.mjs && node .pi/extensions/shunt/test-shunt.mjs && node .pi/shared/diagnostics/test-diagnostics.mjs && node .pi/extensions/ripple/test-ripple.mjs`。**Commit boundary：** docs + real-stack smoke。

## 4. 驗收與風險

- **硬性驗收：**所有四個 Node suite 通過；shunt 既有 56 checks 不因診斷缺席而退化；`shunt` 是本功能唯一改寫 read result 的 extension；ripple 永不回傳 tool output replacement；diagnostics config 壞、linter 缺席／超時、git 失敗均 fail-open，lint unavailable 不產生誤導性新／已修復快照；無需靠 extension 加載順序。
- **重點風險與最小 probe：**pi `tool_call` 的 edit/write pre-image 已由跨 process 雙輪 smoke 驗證（修改前無 lint、修改後新增 F841，下一輪回報 `ripple=yes[F841]`）。原先規劃的記憶體 pending+`context` 只在同 process 有效；已改為 `turn_end` 持久化 custom_message，不要求自動續輪。Biome（v1/v2）與 Ruff 的 schema/退出碼已 live 驗證（2026-07-19）；ShellCheck 尚未安裝、仍為 SKIP；未驗證時不將 SKIP 說成通過。Slice 1～4 fixture 測試執行通過；`ripple` 已用 fake CLI＋`cliproxyapi/gemini-3.1-flash-lite` 完成跨 process 雙輪 smoke（`ripple=yes[F841]`）；此 smoke 驗證持久化交付，不等同 linter CLI schema live 驗證。
- **取代關係：**舊 `t-diag` spec 的 `message_end` read 串接與單插件切片完全棄用；本文件是後續實作的唯一規格。只讀 pre-flight 已針對 codebase 校對並修正 selector 首行、lint 快取與新檔 baseline；使用者已審閱並授權依切片實作；若既有 spec 與 live smoke 衝突，以經驗證的持久化交付結果為準並同步更新本文件。
