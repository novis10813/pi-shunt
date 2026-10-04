# ripple — 回合後變動提示

`ripple` 是 post-turn extension，不註冊任何工具、不修改工具輸出；read 結果的改寫只由 shunt 負責。ripple 在 `tool_call(edit/write)` 取修改前 linter 快照，在成功 `tool_result` 記錄 touched，於 `turn_end` 重跑 lint 對照差集並寫入 session 的 `custom_message` entry；下次模型請求讀到持久化的新增診斷提示（跨 process 仍有效）。沒有下次請求就沒有即時提示（不主動喚醒模型）。rename 提示同樣只注入證據，由 agent 自決是否修改／詢問。

兩 extension 共用 `shared/diagnostics/` 純模組，依 `<cwd>/.pi/diagnostics.json` 選擇檔案類型、lint CLI 與 timeout。沒有設定檔即啟用預設值；預設 CLI：TS/JS `biome check --reporter=json {files}`、Python `ruff check --output-format json --no-fix {files}`、Shell `shellcheck -f json {files}`。不安裝任何 CLI，缺席或輸出無法解析時跳過 lint。本機已裝 ruff 0.16.9 與 biome 2.5.14（2026-07-19 live 驗證；Biome v1/v2 兩版 schema 皆解析）；shellcheck 未安裝，該語言 SKIP。

`<cwd>/.pi/ripple.json`（選用）：

```json
{"enabled": true, "rename": true, "measure": false}
```

- `enabled:false` 停用 ripple，不影響 shunt；`rename:false` 只停用 rename；`measure:true` 將匿名計數 JSONL 記在 `~/.local/state/ripple/measure.log`。
- 預檢失敗不當作零診斷；只有修改前後都成功解析才報新增。新建檔明確不存在時以空集合為基線；最多處理本輪 20 個檔案。每輪最多一則 `ripple-delta` 和一則 `ripple-rename` journal entry；`context` 只在下一個 user turn 保留新提示，後續請求隱藏過期提示，不修改 journal，也不使用記憶體 pending 注入。
- rename 用 staged/unstaged `git diff --find-renames` 掃描，對舊路徑／檔名（含去副檔名）跑 `git grep -n -z -F`（`-z` 使輸出為 `path\0line\0content`、路徑不被 C-quote，含 `:` 的路徑與內容中的 `:N:` 皆無歧義）；已 nudge 過的 rename 在 grep 前即被過濾（不佔 5 筆上限、不花 grep）；git 呼叫一律帶 `-c core.fsmonitor=`，diff 另帶 `--no-ext-diff`（subcommand 選項），防 hostile repo 的 fsmonitor/ext-diff 設定被執行；純 `mv` 後目的檔未追蹤的 rename 無法由 git diff 偵測。非 git repo、git 失敗皆靜默跳過。
- 單輪外的 git/bash 寫入不列為 touched；delta 為本輪成功 edit/write 的 before/after，不是全 repo lint。

驗證：`node extensions/ripple/test-ripple.mjs`。與 shunt 完整設計見 `docs/read_diagnostics_ripple_spec.md`。
