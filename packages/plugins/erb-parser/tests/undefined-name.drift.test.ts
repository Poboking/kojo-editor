/**
 * D01 名字尺漂移钉死测试（ERBDIAG-A，2026-11-20）。
 *
 * 本批选的是**诊断腿先对齐**（未定义名腿换上引擎分隔集），声明侧/引用侧那把
 * `isErbDimNameCode` 暂留原排除集。于是仓里**明晃晃摆着两把尺**——这本来不许发生，
 * 唯一合法的并存形态是：**逐字符台账 + 每条都有实测量**。谁改了任一边、
 * 差异台账里没有这一格，本文件当场红。
 *
 * 台账数据来源（eraTW 4.981-261017-EAGLOV3，只读）：
 * - 声明侧爆炸半径：38,331 条声明行、唯一名 **18,864 → 18,864**，切名不一致 **0**
 *   ⇒ 把声明侧一次对齐到引擎那把，本盘**零**名录键变化（快照 `SNAPSHOT_VERSION` /
 *   `nameSetDigest` / 引用流水 / `.ERH` 常量名全不受影响）。
 * - 诊断侧假红：换尺前 1,190 条 `ERB_UNDEFINED_NAME`，其中 1,141 条（95.9%）记号紧邻
 *   `·`(U+00B7) 一类**非**引擎分隔符 ⇒ 根因是尺子不是名字。
 * 声明侧没跟着走的原因：`dim-family.test.ts` 钉的是「`isErbDimNameChar` 与 JS `\s` 逐码位
 * 等价」，那是另一条车道的判据；本批不替它改口径（见回执「我故意没做的口子」）。
 */
import { describe, expect, it } from 'vitest';
import { ERB_ENGINE_NAME_DELIMITERS, ERB_NAME_RUN_SOURCE, isErbDimNameCode, isErbEngineNameCode } from '../src/scanner';
import { collectUndefinedNameDiagnostics } from '../src/undefined-name';

const fmt = (code: number) => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;

/** 差异①：声明侧算分隔符、**引擎算名字字符**（换尺后诊断腿会把这类字符留在名字里） */
const DECLARATION_SPLITS_ENGINE_JOINS: readonly string[] = [
  // 行分隔符：引擎按行喂 `RowString`，这些字符根本到不了 `ReadSingleIdentifierROS`；
  // 我们的判据会被整篇文本调用，故仍当分隔符（保守，不会造成碎名假红）。
  fmt(0x0a),
  fmt(0x0b),
  fmt(0x0c),
  fmt(0x0d),
  // 反引号：引擎 `RowIdentifier` 不认它是分隔符（`_searchValues` 里没有 0x60）。
  fmt(0x60),
  // JS `\s` 的非 ASCII 空白（引擎只把 `\u3000` 当分隔符）。
  fmt(0x00a0),
  fmt(0x1680),
  fmt(0x2000),
  fmt(0x2001),
  fmt(0x2002),
  fmt(0x2003),
  fmt(0x2004),
  fmt(0x2005),
  fmt(0x2006),
  fmt(0x2007),
  fmt(0x2008),
  fmt(0x2009),
  fmt(0x200a),
  fmt(0x2028),
  fmt(0x2029),
  fmt(0x202f),
  fmt(0x205f),
  fmt(0xfeff),
];

/** 差异②：引擎算分隔符、**声明侧算名字字符**（本盘 0 条声明名吃到，故暂不收口） */
const ENGINE_SPLITS_DECLARATION_JOINS: readonly string[] = [
  fmt(0x2e), // .
  fmt(0x23), // #
  fmt(0x24), // $
  fmt(0x40), // @
  fmt(0x3f), // ?
  fmt(0x7e), // ~
  // `^`（异或运算符）：声明侧那张排除集从来没列它（对不上它自己的文档口径），
  // 本批不改声明侧、只把这一格钉进台账——收口那天它必须消失。
  fmt(0x5e),
];

describe('D01 · 两把尺子的逐字符差异台账（不许静默漂移）', () => {
  it('BMP 全量对拍：差异集合恰好等于两份白名单', () => {
    const declSplits: string[] = [];
    const engineSplits: string[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      const decl = isErbDimNameCode(code);
      const engine = isErbEngineNameCode(code);
      if (decl === engine) continue;
      (engine ? declSplits : engineSplits).push(fmt(code));
    }
    expect(declSplits.sort()).toEqual([...DECLARATION_SPLITS_ENGINE_JOINS].sort());
    expect(engineSplits.sort()).toEqual([...ENGINE_SPLITS_DECLARATION_JOINS].sort());
  });

  it('D01 的根因字符一枚都不许是引擎分隔符（`·`/`・`/`（）`/`／`/`？`/`％`/零宽空格/全角下划线）', () => {
    for (const code of [0x00b7, 0x30fb, 0xff65, 0xff08, 0xff09, 0xff0f, 0xff1f, 0xff05, 0x200b, 0xff3f, 0x3001, 0xff5c]) {
      expect(isErbEngineNameCode(code), `${fmt(code)} 被当成引擎分隔符了`).toBe(true);
    }
  });

  it('真源串与两个出口等价：码位判据 ≡ 正则字符类（同一串抄录，不许各写一遍）', () => {
    expect(ERB_ENGINE_NAME_DELIMITERS).toBe(' \t　.+-*/%=!<>|&^~?#)}],:({[$\'"@;');
    const single = new RegExp(`^${ERB_NAME_RUN_SOURCE}$`, 'u');
    const mismatched: string[] = [];
    // 代理区不比：`u` 旗的正则按码点扫，孤立代理码元问"是不是名字字符"没有意义
    // （真实遍历里增平面字符成对出现，两把尺都当名字字符）。
    for (let code = 0; code <= 0xffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      const viaPredicate = isErbEngineNameCode(code);
      const viaRegex = single.test(String.fromCharCode(code));
      if (viaPredicate !== viaRegex) mismatched.push(fmt(code));
    }
    expect(mismatched, `正则形态与码位形态不等价的码位：${mismatched.slice(0, 20)}`).toEqual([]);
  });

  it('差异②的后果摆在这里（本盘 0 条声明名吃到）：名字含 `.` 时声明侧与诊断侧不重合', () => {
    // `#DIM A.B` 按声明侧是一整枚名字，诊断侧按引擎切成 `A` / `B` ⇒ 两条命中。
    // 这条**故意**留红着记号：它不是新造的假红，而是两把尺并存的代价，收口那天由语料闸门验收。
    expect(collectUndefinedNameDiagnostics({ text: '#DIM A.B\nIF A.B > 0', path: 'X.ERB' }).map((d) => d.name)).toEqual([
      'A',
      'B',
    ]);
  });
});
