/**
 * eraFL 载体归属（LAU-D3）的闸。
 *
 * 钉四件事：
 * 1. **三条载体各归其位**：口上 XML → `xml`、ERB/ERH → `erb`、`.kojo2` → `inline`，
 *    其它文件（CSV 等）**不归属**（不猜）；
 * 2. **事件面只在 xml / inline 上校验**：ERB 载体的 `validates` 不含 `event`
 *    ——这是"`# 机` 写进 ERB 必须报 `core/event/wrong-carrier`"的数据前提；
 * 3. **注册壳前缀是数据**：七个真盘族列全、互不为前缀（前缀匹配不会互相吞）；
 * 4. **契约自洽**：`validateGameAdapter(ERAFL_GAME_ADAPTER)` 零诊断（`shells` 形状合法）。
 */
import { describe, expect, it } from 'vitest';
import {
  factKindsOf,
  findCarrierBinding,
  resolveDialectBinding,
  validateGameAdapter,
} from '@kojo/kojo-core';
import {
  ERAFL_CARRIERS,
  ERAFL_ERB_SHELL_PREFIXES,
  ERAFL_GAME_ADAPTER,
  ERAFL_XML_CARRIER_GLOB,
} from '../src/kojo2';

/** 真盘形态的路径（相对工程根、正斜杠） */
const XML_PATH = 'ERB/口上/1099_うふふお姉さん/KOJO_K1099_COM.xml';
const XML_DEEP = 'ERB/口上/1001_汎用_クール/うふふ/KOJO_K1001_COM.xml';
const ERB_PATH = 'ERB/SYSTEM/NEWGAME.ERB';
const ERB_LOWER = 'ERB/口上/1_测试/kojo_define_k1.erb';
const ERH_PATH = 'ERB/SYSTEM/FL_INIT_LOADER.ERH';
const KOJO2_PATH = '我的口上/初见.kojo2';
const CSV_PATH = 'CSV/FLAG.CSV';

describe('三条载体各归其位', () => {
  it('口上 XML → xml（含深一层目录）', () => {
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, XML_PATH)?.carrier).toBe('xml');
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, XML_DEEP)?.carrier).toBe('xml');
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, XML_PATH)?.glob).toBe(ERAFL_XML_CARRIER_GLOB);
  });

  it('ERB / 小写 erb / ERH → erb', () => {
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, ERB_PATH)?.carrier).toBe('erb');
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, ERB_LOWER)?.carrier).toBe('erb');
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, ERH_PATH)?.carrier).toBe('erb');
  });

  it('`.kojo2` → inline（2.0 引擎事件只在这类文件里成立）', () => {
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, KOJO2_PATH)?.carrier).toBe('inline');
  });

  it('CSV / 其它文件不归属（不猜）', () => {
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, CSV_PATH)).toBeUndefined();
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, 'readme.txt')).toBeUndefined();
  });

  it('大小写敏感：`ERB/口上/**/*.xml` 不认 `.XML`（归属是数据不是宽恕）', () => {
    expect(findCarrierBinding(ERAFL_GAME_ADAPTER, 'ERB/口上/1_x/A.XML')).toBeUndefined();
  });
});

describe('事件面只在 xml / inline 上校验', () => {
  it('xml 载体校验 event；erb 载体不校验 event', () => {
    const xml = findCarrierBinding(ERAFL_GAME_ADAPTER, XML_PATH);
    const erb = findCarrierBinding(ERAFL_GAME_ADAPTER, ERB_PATH);
    expect(xml).toBeDefined();
    expect(erb).toBeDefined();
    expect(factKindsOf(xml!)).toEqual(['event']);
    expect(factKindsOf(erb!)).toEqual(['symbol', 'presentation', 'storage']);
    expect(factKindsOf(erb!)).not.toContain('event');
  });

  it('inline 载体省略 validates = 全部四类（`# 机` 的引擎事件在这里校验）', () => {
    const inline = findCarrierBinding(ERAFL_GAME_ADAPTER, KOJO2_PATH);
    expect(factKindsOf(inline!)).toEqual(['event', 'symbol', 'presentation', 'storage']);
  });
});

describe('注册壳前缀（ERB 上的"这条事件在 xml"提示用）', () => {
  it('七族列全', () => {
    expect([...ERAFL_ERB_SHELL_PREFIXES].sort()).toEqual(
      [
        'KOJO_DEFINE_KOJO_INFO_K',
        'KOJO_DEFINE_NAME_K',
        'KOJO_FOR_FEMALE_K',
        'KOJO_FOR_MALE_K',
        'KOJO_XML_COMGROUP_K',
        'KOJO_XML_INIT_K',
        'KOJO_DEFINE_K',
      ].sort(),
    );
  });

  it('「前缀 + 紧跟编号」口径：真盘壳函数名命中、引擎流程函数不命中', () => {
    /** 与宿主悬停那条腿同一判据（`kojo-hover.ts::shellCarrierOf`） */
    const hits = (name: string): boolean => {
      const upper = name.toUpperCase();
      return ERAFL_ERB_SHELL_PREFIXES.some(
        (prefix) => upper.startsWith(prefix) && /[0-9]/.test(upper.charAt(prefix.length)),
      );
    };
    expect(hits('KOJO_DEFINE_K1099')).toBe(true);
    expect(hits('KOJO_DEFINE_NAME_K1099')).toBe(true);
    // `KOJO_DEFINE_K` 后面跟的是 `O`（不是编号）⇒ 只由它自己那条命中，仍算壳
    expect(hits('KOJO_DEFINE_KOJO_INFO_K1099')).toBe(true);
    expect(hits('KOJO_XML_INIT_K1099')).toBe(true);
    expect(hits('KOJO_XML_COMGROUP_K1099')).toBe(true);
    expect(hits('KOJO_FOR_MALE_K1099')).toBe(true);
    expect(hits('KOJO_FOR_FEMALE_K1099')).toBe(true);
    // 小写也要认（Emuera 函数名大小写不敏感）
    expect(hits('kojo_define_k1099')).toBe(true);
    // 引擎流程函数不是壳
    expect(hits('EVENTFIRST')).toBe(false);
    expect(hits('KOJO_EVENT_K4')).toBe(false);
    // 没有编号的裸前缀不是壳（不猜）
    expect(hits('KOJO_DEFINE_K')).toBe(false);
  });
});

describe('契约自洽', () => {
  it('validateGameAdapter(ERAFL_GAME_ADAPTER) 零诊断（含 shells 形状）', () => {
    expect(validateGameAdapter(ERAFL_GAME_ADAPTER)).toEqual([]);
  });

  it('真解析器按项目根归属：同一个 adapter 既给 XML 也给 ERB 各自的载体', () => {
    const xml = resolveDialectBinding({
      detectedDialect: 'erafl',
      factsFor: () => ERAFL_GAME_ADAPTER,
      filePath: XML_PATH,
    });
    const erb = resolveDialectBinding({
      detectedDialect: 'erafl',
      factsFor: () => ERAFL_GAME_ADAPTER,
      filePath: ERB_PATH,
    });
    expect(xml.kind).toBe('bound');
    expect(xml.binding?.carrier).toBe('xml');
    expect(erb.kind).toBe('bound');
    expect(erb.binding?.carrier).toBe('erb');
    // 归属成功 ⇒ 一条 core/carrier/unowned 都没有
    expect(xml.diagnostics.filter((d) => d.code === 'core/carrier/unowned')).toEqual([]);
    expect(erb.diagnostics.filter((d) => d.code === 'core/carrier/unowned')).toEqual([]);
  });

  it('不在任何 glob 里的文件：绑定成功 + 一条 core/carrier/unowned（不静默）', () => {
    const resolution = resolveDialectBinding({
      detectedDialect: 'erafl',
      factsFor: () => ERAFL_GAME_ADAPTER,
      filePath: CSV_PATH,
    });
    expect(resolution.kind).toBe('bound');
    expect(resolution.binding?.carrier).toBeNull();
    expect(resolution.diagnostics.map((d) => d.code)).toContain('core/carrier/unowned');
  });

  it('载体表本身冻结（装载后不许改）', () => {
    expect(Object.isFrozen(ERAFL_CARRIERS)).toBe(true);
    expect(ERAFL_CARRIERS.every((item) => Object.isFrozen(item))).toBe(true);
  });
});
