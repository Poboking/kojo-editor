/**
 * eraTW 载体归属（LAU-D4 车 ①）的闸——与 eraFL 那份（`erafl-adapter/tests/carriers.test.ts`）
 * **同构不同值**：同一套 `CarrierBinding` 契约，钉各自盘上事实。
 *
 * 钉五件事：
 * 1. **两条载体各归其位**：ERB/ERH → `erb`、`.kojo2` → `inline`，CSV / XML / 其它**不归属**（不猜）；
 * 2. **eraTW 的 ERB 面校验事件**（`validates` 省略 = 四类全量）——eraFL 的 ERB 刻意剥 `event`，
 *    两家的差异落在**数据**上，宿主读的是同一张表；
 * 3. **XML 不声明是裁决不是漏写**：eraTW 盘上 XML 不是方言事实载体，声明零校验的 xml 归属
 *    会把 XML 三格全判成 `wrong-carrier`（见 `src/kojo2/carriers.ts` 头注第二条）；
 *    不声明的效果 = 可见的 `core/carrier/unowned`，不是静默；
 * 4. **契约自洽**：`validateGameAdapter(ERATW_GAME_ADAPTER)` 零诊断（carriers 形状合法）；
 * 5. **表冻结**：装载后不许改。
 */
import { describe, expect, it } from 'vitest';
import {
  factKindsOf,
  findCarrierBinding,
  resolveDialectBinding,
  validateGameAdapter,
} from '@kojo/kojo-core';
import { ERATW_CARRIERS, ERATW_GAME_ADAPTER } from '../src/kojo2';

/** 真盘形态的路径（相对工程根、正斜杠；口上域读法见 `src/constants.ts` 的 `kojoRoot`） */
const KOJO_ERB = 'ERB/口上・メッセージ関連/個人口上/063 Kagerou [影狼]/影狼/M_KOJO_K63_イベント.ERB';
const SYSTEM_ERB = 'ERB/SYSTEM/NEWGAME.ERB';
const ERB_LOWER = 'ERB/口上・メッセージ関連/m_kojo_k63.erb';
const ERH_PATH = 'ERB/SETDATA/TOP.ERH';
const KOJO2_PATH = '我的口上/初见.kojo2';
const XML_PATH = 'ERB/口上・メッセージ関連/KOJO_K1099_COM.xml';
const CSV_PATH = 'CSV/FLAG.CSV';

describe('eraTW 两条载体各归其位', () => {
  it('口上 ERB / 系统 ERB / 小写 erb / ERH → erb', () => {
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, KOJO_ERB)?.carrier).toBe('erb');
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, SYSTEM_ERB)?.carrier).toBe('erb');
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, ERB_LOWER)?.carrier).toBe('erb');
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, ERH_PATH)?.carrier).toBe('erb');
  });

  it('`.kojo2` → inline（2.0 面与 ERB 面同权的并列载体）', () => {
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, KOJO2_PATH)?.carrier).toBe('inline');
  });

  it('CSV / XML / 其它文件不归属（不猜——XML 不是 eraTW 的方言载体，见夹具头注）', () => {
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, CSV_PATH)).toBeUndefined();
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, XML_PATH)).toBeUndefined();
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, 'readme.txt')).toBeUndefined();
  });

  it('大小写敏感：小写目录 `erb/` 与大写扩展名 `.XML` 都不认（归属是数据不是宽恕）', () => {
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, 'erb/系统/x.ERB')).toBeUndefined();
    expect(findCarrierBinding(ERATW_GAME_ADAPTER, 'ERB/x.XML')).toBeUndefined();
  });
});

describe('eraTW 的 ERB 面校验事件（与 eraFL 的对面事实）', () => {
  it('erb 载体省略 validates = 四类事实全量（`# 机` 落口上运行时住在 ERB 这一格）', () => {
    const erb = findCarrierBinding(ERATW_GAME_ADAPTER, KOJO_ERB);
    expect(erb).toBeDefined();
    expect(erb!.validates).toBeUndefined();
    expect(factKindsOf(erb!)).toEqual(['event', 'symbol', 'presentation', 'storage']);
  });

  it('inline 载体同样全量（2.0 的事件/符号/演出/存储期都在 `.kojo2` 上成立）', () => {
    const inline = findCarrierBinding(ERATW_GAME_ADAPTER, KOJO2_PATH);
    expect(factKindsOf(inline!)).toEqual(['event', 'symbol', 'presentation', 'storage']);
  });
});

describe('契约自洽与解析行为', () => {
  it('validateGameAdapter(ERATW_GAME_ADAPTER) 零诊断（carriers 形状合法）', () => {
    expect(validateGameAdapter(ERATW_GAME_ADAPTER)).toEqual([]);
  });

  it('真解析器：ERB 文件绑定成功、carrier=erb、一条 `core/carrier/unowned` 都没有', () => {
    const resolution = resolveDialectBinding({
      detectedDialect: 'eratw',
      factsFor: () => ERATW_GAME_ADAPTER,
      filePath: KOJO_ERB,
    });
    expect(resolution.kind).toBe('bound');
    expect(resolution.binding?.carrier).toBe('erb');
    expect(resolution.diagnostics.filter((d) => d.code === 'core/carrier/unowned')).toEqual([]);
  });

  it('不在归属里的 XML：绑定成功 + carrier=null + 一条可见的 `core/carrier/unowned`（不静默）', () => {
    const resolution = resolveDialectBinding({
      detectedDialect: 'eratw',
      factsFor: () => ERATW_GAME_ADAPTER,
      filePath: XML_PATH,
    });
    expect(resolution.kind).toBe('bound');
    expect(resolution.binding?.carrier).toBeNull();
    expect(resolution.diagnostics.map((d) => d.code)).toContain('core/carrier/unowned');
  });

  it('载体表本身冻结（装载后不许改）', () => {
    expect(Object.isFrozen(ERATW_CARRIERS)).toBe(true);
    expect(ERATW_CARRIERS.every((item) => Object.isFrozen(item))).toBe(true);
  });
});
