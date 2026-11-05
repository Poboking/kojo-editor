/**
 * 回放「未建模写」指令表 × 引擎指令表的**防回潮钉子**（2026-11-05 状态回放彻底可用批）。
 *
 * 背景：`state-replay/src/writes.ts` 的 `WRITE_INSTRUCTIONS` 是手工短表，上一版出现过
 * 三个**猜出来的假名**（`RESETGLOBALDATA` / `SAVEGLOBALDATA` / `LOADGLOBALDATA`）——
 * 真语料 0 命中，而测试把假名当真指令钉住，于是「漏报」永远不会被发现。写检测的
 * 契约是「`[]` = 未检出已知写点」，表里混进不存在的名字 = 静默漏报。
 *
 * 本测试把短表与**引擎指令表**（`erb-parser/src/instructions.ts` 的
 * `ERB_INSTRUCTION_NAMES`，303 词）对拍：短表必须是它的子集。这是"表里不许有假名"的
 * 机器判据；反方向（引擎里还有哪些写指令没进表）不做硬断言——那要人判"算不算写"。
 */
import { describe, expect, it } from 'vitest';
import { WRITE_INSTRUCTIONS } from '@kojo/plugin-state-replay';
import { ERB_INSTRUCTION_NAMES, ERB_STATEMENT_DIRECTIVES } from '@kojo/plugin-erb-parser';

describe('回放写指令表 ⊆ 引擎指令表（防假名）', () => {
  it('短表里每一条都必须真的在引擎指令全集里', () => {
    // 引擎词分两张表：指令名（`ERB_INSTRUCTION_NAMES`）+ 语句指令（`ERB_STATEMENT_DIRECTIVES`，
    // 写状态的那一族 EQUIP / MAP_SET / DT_* 在这里）；短表必须是两表并集的子集。
    const engine = new Set([...ERB_INSTRUCTION_NAMES, ...ERB_STATEMENT_DIRECTIVES]);
    const unknown = [...WRITE_INSTRUCTIONS].filter((name) => !engine.has(name)).sort();
    // 名字打错 / 凭印象发明 的形态：这里直接点名报出来，点名的就是"假名"
    expect(unknown, `短表里有 ${unknown.length} 个不在引擎指令表里的名字：${unknown.join(', ')}`).toEqual([]);
  });

  it('短表覆盖真语料里高频的状态写指令（VARSET / EQUIP / SAVEGLOBAL 一族）', () => {
    for (const name of ['VARSET', 'CVARSET', 'EQUIP', 'UNEQUIP', 'SAVEGLOBAL', 'LOADGLOBAL', 'RESETGLOBAL', 'RANDOMIZE']) {
      expect(WRITE_INSTRUCTIONS.has(name), `短表缺 ${name}（真语料高频写指令）`).toBe(true);
    }
  });
});
