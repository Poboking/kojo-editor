/**
 * **三列载体归属**（LAU-D4 车 ① 的形态闸：方言扩展一致性 × 归属是数据）。
 *
 * 一份 `CarrierBinding` 契约、三列方言数据（eraTW / eraFL / demo），同一套解析器
 * （`resolveDialectBinding` / `findCarrierBinding`）跑同一批断言——这就是
 * "新增一门方言 = 新增一个包 + 清单一行，宿主零改动"在**载体轴**上的可执行版本
 * （`docs/ARCH-language-unification.md` §9-10 判据的数据半格）：
 *
 * 1. **三列都声明 `carriers` 且契约自洽**：`validateGameAdapter` 逐列零诊断；
 * 2. **同一张表的三条腿**：`.kojo2` 在三列里都归 `inline`（2.0 面跨方言同扩展名，
 *    eraTW 夹具头注记的那条"次序只表达并列"在这里对三列同时成立）；
 * 3. **同路径不同数据**：`ERB/**.ERB` 在 eraTW / demo 校验事件（`validates` 省略=全量）、
 *    在 eraFL **刻意剥掉** `event`（注册壳只剩壳）——归属判出的载体同名、校验面相反，
 *    差异全部落在方言包的数据上，宿主与解析器没有一行 era 分支；
 * 4. **错配可见**：不在归属里的文件（CSV）在每一列都得一条 `core/carrier/unowned`
 *    （不静默，铁律 4）。
 */
import { describe, expect, it } from 'vitest';
import type { GameAdapter } from '@kojo/kojo-core';
import { factKindsOf, findCarrierBinding, resolveDialectBinding, validateGameAdapter } from '@kojo/kojo-core';
import { ERATW_GAME_ADAPTER } from '@kojo/plugin-eratw-adapter';
import { ERAFL_GAME_ADAPTER } from '@kojo/plugin-erafl-adapter/kojo2';
import { DEMO_CARRIERS, DEMO_GAME_ADAPTER } from './fixtures/dialect-demo/index.js';

/** 三列注册表：与 `language-shared.test.ts` 同一把尺（列从数据来，判定零改动） */
const COLUMNS: readonly { readonly id: string; readonly adapter: GameAdapter }[] = [
  { id: 'eratw', adapter: ERATW_GAME_ADAPTER },
  { id: 'erafl', adapter: ERAFL_GAME_ADAPTER },
  { id: 'demo', adapter: DEMO_GAME_ADAPTER },
];

const ERB_PATH = 'ERB/口上・メッセージ関連/個人口上/063 Kagerou [影狼]/影狼/M_KOJO_K63.ERB';
const KOJO2_PATH = '我的口上/初见.kojo2';
const CSV_PATH = 'CSV/FLAG.CSV';

describe('三列都声明 carriers 且契约自洽', () => {
  it('每列 `validateGameAdapter` 零诊断、`carriers` 声明过（数组且非空）', () => {
    for (const { id, adapter } of COLUMNS) {
      expect(validateGameAdapter(adapter), id).toEqual([]);
      expect(Array.isArray(adapter.carriers), id).toBe(true);
      expect((adapter.carriers ?? []).length, id).toBeGreaterThan(0);
    }
  });

  it('`.kojo2` 在三列里都归 `inline`（2.0 面跨方言同一条腿）', () => {
    for (const { id, adapter } of COLUMNS) {
      expect(findCarrierBinding(adapter, KOJO2_PATH)?.carrier, id).toBe('inline');
    }
  });
});

describe('同路径不同数据：归属同名、校验面各按盘上事实', () => {
  it('同一枚 ERB 路径在三列都归 `erb` 载体', () => {
    for (const { id, adapter } of COLUMNS) {
      expect(findCarrierBinding(adapter, ERB_PATH)?.carrier, id).toBe('erb');
    }
  });

  it('eraTW / demo 的 erb 面校验事件，eraFL 的 erb 面刻意不校验（差异全在数据）', () => {
    const kinds = (adapter: GameAdapter): readonly string[] => {
      const binding = findCarrierBinding(adapter, ERB_PATH);
      expect(binding, adapter.id).toBeDefined();
      return factKindsOf(binding!);
    };
    expect(kinds(ERATW_GAME_ADAPTER)).toContain('event');
    expect(kinds(DEMO_GAME_ADAPTER)).toContain('event');
    expect(kinds(ERAFL_GAME_ADAPTER)).not.toContain('event');
  });

  it('eraFL 的 XML 是三列里唯一校验事件的 xml 载体；eraTW / demo 不声明 XML（不猜）', () => {
    const xml = 'ERB/口上/1099_うふふお姉さん/KOJO_K1099_COM.xml';
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, xml)?.carrier).toBe('xml');
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, xml)).toBeUndefined();
    expect(findCarrierBinding(DEMO_GAME_ADAPTER, xml)).toBeUndefined();
  });
});

describe('解析器对三列走同一条链（错配可见，不静默）', () => {
  it('`.kojo2` 与 ERB 文件在每列都绑定成功且归属命中（零 `core/carrier/unowned`）', () => {
    for (const { id, adapter } of COLUMNS) {
      for (const filePath of [ERB_PATH, KOJO2_PATH]) {
        const resolution = resolveDialectBinding({
          detectedDialect: id,
          factsFor: () => adapter,
          filePath,
        });
        expect(resolution.kind, `${id} · ${filePath}`).toBe('bound');
        expect(resolution.binding?.carrier, `${id} · ${filePath}`).not.toBeNull();
        expect(resolution.diagnostics.filter((d) => d.code === 'core/carrier/unowned'), id).toEqual([]);
      }
    }
  });

  it('CSV 不在任何 glob：每列都是绑定成功 + carrier=null + 一条可见的 unowned', () => {
    for (const { id, adapter } of COLUMNS) {
      const resolution = resolveDialectBinding({
        detectedDialect: id,
        factsFor: () => adapter,
        filePath: CSV_PATH,
      });
      expect(resolution.kind, id).toBe('bound');
      expect(resolution.binding?.carrier, id).toBeNull();
      expect(resolution.diagnostics.map((d) => d.code), id).toContain('core/carrier/unowned');
    }
  });

  it('demo 列的载体表冻结（第三门方言带的也是只读数据）', () => {
    expect(Object.isFrozen(DEMO_CARRIERS)).toBe(true);
    expect(DEMO_CARRIERS.every((item) => Object.isFrozen(item))).toBe(true);
  });
});
