/**
 * KW-22（2026-11-03）：**姊妹族名表借用两本账的「重叠边同向」闸**。
 *
 * 同一条引擎事实（era 引擎把同一张名字表挂在两个族头下：`NOWEX` 的具名索引住在 `EX`
 * 的表里、`DOWNBASE` 住在 `BASE` 里、盘上没有 `NOWEX.csv`）今天在仓里有**两本账**，
 * 分属两条消费轴，各自的**准入判据不同**（判性结论：两职，不该合表）：
 * - **核对轴**（kojo-vocab `CHECKED_FAMILY_NAME_TABLES`）：`族头:具名` 拼错名核对的
 *   白名单——入库判据 = adapter 字典在真语料上把该族 warn 面打到 0 或只剩真阳性，
 *   宁缺毋滥（登记了就会向作者报警，错登记 = 假命中上屏）；含七枚「本族自有表」单员，
 *   不含 `MAXBASE`（warn 面无实证）。
 * - **解析轴**（eratw-adapter `DERIVED_NAME_TABLE_SOURCES`）：解析具名索引时的
 *   「本族一张表都没有 ⇒ 借姊妹族成品表」换算登记——准入判据 = 盘上同名同编号配对
 *   实证；答不出就落 unknown，结构上造不出假命中，故可登记核对侧不收的 `MAXBASE`；
 *   分母是 `ENGINE_FAMILIES` 全集（借表台账 + 排除台账恰落一处）。
 *
 * **为什么不合一**：往任一方向合都会冲掉另一侧的准入判据——合进核对侧 = 未过 warn 面
 * 实证的 `MAXBASE` 被推进核对白名单（假阳性风险，违「宁缺毋滥」）；合进解析侧 =
 * 七枚单表成员被当成「在册借表」进全覆盖台账（与排除台账的互斥口径直接冲突）。
 * （注：插件依赖 kojo-vocab 本仓有先例——kojo-sugar / erb-parser / erb-lang 皆已声明并
 * 通过 audit B/C，「合进 vocab 让 adapter 吃」这条路机器上通；不合的理由是上句的判据冲突，
 * 不是依赖边不通。先例形状照 `erb-family-single-source.test.ts`：两侧名单各司其职，
 * **关系**钉成结构闸。）
 *
 * 于是本闸只钉一件事：**同一家族头在两账都出现时，借的必须同向**（谁漂了都红）；
 * 值域不对称逐枚钉成边界判据——要改任何一边，先带来那一侧准入判据的实证。
 */
import { describe, expect, it } from 'vitest';
import { CHECKED_FAMILY_NAME_TABLES } from '@kojo/kojo-vocab/engine';
import { DERIVED_NAME_TABLE_SOURCES } from '@kojo/plugin-eratw-adapter';

/** 核对轴的借道边：候选多于一条者；首条恒为族头本身，其后才是借的姊妹表 */
const checkedBorrowEdges: readonly (readonly [string, readonly string[]])[] = Object.entries(
  CHECKED_FAMILY_NAME_TABLES,
)
  .filter(([, keys]) => keys.length > 1)
  .map(([family, keys]) => [family, keys.slice(1)] as const)
  .sort(([a], [b]) => a.localeCompare(b));

describe('姊妹族名表借用 · 核对轴与解析轴的重叠边同向闸', () => {
  it('核对轴候选表首条恒为本族头（本族表永远优先——与解析轴 derivedTableOf 的裁决次序同构）', () => {
    for (const [family, keys] of Object.entries(CHECKED_FAMILY_NAME_TABLES)) {
      expect(keys[0], `${family} 的候选首条必须是它自己`).toBe(family);
      expect(new Set(keys).size, `${family} 的候选不许重登`).toBe(keys.length);
    }
  });

  it('核对轴的每一条借道边都在解析账上在册且同向（核对侧漂向 / 借了解析侧没登记的表 ⇒ 红）', () => {
    expect(checkedBorrowEdges.length).toBeGreaterThan(0);
    for (const [family, sisters] of checkedBorrowEdges) {
      for (const sister of sisters) {
        expect(
          DERIVED_NAME_TABLE_SOURCES[family],
          `核对轴让 ${family} 借 ${sister} 的表，解析账在册的却是「${DERIVED_NAME_TABLE_SOURCES[family]}」或压根没登记——两本账漂了，带实证来改`,
        ).toBe(sister);
      }
    }
  });

  it('解析账的每一条借道边若被核对轴核对，也必须同向（解析侧漂向 ⇒ 红；核对轴不收的族由边界闸管）', () => {
    for (const [family, source] of Object.entries(DERIVED_NAME_TABLE_SOURCES)) {
      const keys = CHECKED_FAMILY_NAME_TABLES[family];
      if (keys === undefined) continue;
      expect(keys, `解析轴 ${family}→${source} 与核对轴候选 ${JSON.stringify(keys)} 不同向`).toContain(source);
    }
  });

  it('重叠面现状快照：两账同在册的「一张表两个族头」恰是 DOWNBASE→BASE 与 NOWEX→EX 两条', () => {
    expect(checkedBorrowEdges).toEqual([
      ['DOWNBASE', ['BASE']],
      ['NOWEX', ['EX']],
    ]);
  });

  it('边界钉：MAXBASE→BASE 解析侧在册（具名索引配对实证）、核对侧不收（warn 面无实证）——两职的分界本身', () => {
    expect(DERIVED_NAME_TABLE_SOURCES['MAXBASE']).toBe('BASE');
    expect(CHECKED_FAMILY_NAME_TABLES['MAXBASE']).toBeUndefined();
  });

  it('两账的键都不许命中原型污染位（解析轴 aliasTable 无原型；核对轴靠「族头大写归一」挡 lowercase 原型位）', () => {
    for (const poison of ['constructor', 'hasOwnProperty', 'toString', '__proto__']) {
      expect(DERIVED_NAME_TABLE_SOURCES[poison], `解析账命中原型位 ${poison}`).toBeUndefined();
      expect(CHECKED_FAMILY_NAME_TABLES[poison.toUpperCase()], `核对账命中大写原型位 ${poison}`).toBeUndefined();
    }
  });
});
