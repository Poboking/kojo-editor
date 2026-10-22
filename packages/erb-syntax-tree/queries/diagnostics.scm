; ERB 结构诊断（未配对 / 嵌套错误 / 停用区）。
;
; ## 与运行时那条腿的关系
;
; 宿主的结构诊断**不是**查询驱动的：`engine.ts::collectFaults` 直接扫 CST 的 `ERROR` /
; `MISSING`（不深入 ERROR 子树、MISSING 认领到块头行、有界截断），对每门语言一视同仁。
; 本查询是同一批判据的**查询面表述**，供三处使用：
;   · 工具/探针（`tools/parse-corpus.mjs` 一类）按查询列出残缺位置；
;   · 测试直接拿真 wasm 编译本文件，钉住"残缺能捕到、停用区里不许误报"；
;   · 将来的查询式诊断面（若宿主改成查询驱动）不必另写一份模式。
;
; ## 三类形状
;
;   · `ERROR`：错误恢复挂上来的一整段读不通的内容（嵌套错误、残缺表达式、坏标签行）。
;     **不深入** ERROR 子树是运行时的口径（一个错只画一条），本查询只捕 ERROR 节点本身。
;   · `MISSING`：文法在回缩点 / 文末插入的零宽收束记号（`endif_line` / `endselect_line` /
;     `skip_end` …）。它说明"哪一块没有收盘"，位置由运行时认领到块头行。
;   · `skip_block`：`[SKIPSTART]` … `[SKIPEND]`。区间内原文由 external scanner 一次吞成
;     `skip_body`，**不解析、不产行节点** ⇒ 里面的 `IF` / 未闭合引号 / 坏标签都不会变成
;     ERROR —— 这正是"死区不误报"的结构保证（测试用真 wasm 钉住）。

(ERROR) @diagnostic.error
(MISSING) @diagnostic.missing

; 停用区自身（配对检查/工具用）：体内没有行节点，范围就是这一枚块节点
(skip_block) @diagnostic.skip
