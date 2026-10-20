; ERB 结构折叠（`@fold`）——本包首版唯一正式查询。
;
; 宿主约定：取 `@fold` 捕获节点的 `startPosition.row .. endPosition.row`；
; 块末若停在下一行行首（收尾换行吃进 span），`src/index.ts` 的 `foldRanges()` 会回退一行。
; 零跨度（空函数 / 空块）由同一函数滤掉——没有可隐藏的行就不产区间。
;
; 覆盖面：
;   · function_block = `@` 行 → 下一条 `@` 行前一行（EOF 则到文末）
;   · branch_block   = 分支行（ELSE / ELSEIF / CASE / CASEELSE / CATCH）→ 下一分支或收束前一行
;   · <pair>_block   = 开块行 → 收束行；配对类别由 `src/structure.json` 的投影决定
;   · skip_block     = `[SKIPSTART]` → `[SKIPEND]`（区间内原文不解析）
;
; 本清单与 projection 的一致性由 `tests/projection-single-source.test.ts` (e) 钉住：新增配对类别而没进这里 ⇒ 红。
; 查询本身能被编译、`@fold` 能捕到节点，由 `tests/parse-structure.test.ts` 的折叠用例钉住。

(function_block) @fold
(branch_block) @fold
(skip_block) @fold

(if_block) @fold
(select_block) @fold
(for_block) @fold
(while_block) @fold
(repeat_block) @fold
(do_block) @fold
(data_block) @fold
(list_block) @fold
(noskip_block) @fold
(try_block) @fold
(funclist_block) @fold
