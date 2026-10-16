/**
 * ZH-D1 · 拼错的名字不再静默进产物——**表外名分级**判据单测。
 *
 * 钉三件事：
 * 1. **升档判据**（`suggestFunctionName` 的两条近名形状 + 三条阈值常量）：命中表外名**且**
 *    两张函数表里恰有**一个**高置信近名 ⇒ 有候选（error 档）；歧义 / 短名 / 尾巴太长 ⇒ 无候选；
 * 2. **生效点的两档形态**（`expression.ts` 调用形态分支）：唯一候选 ⇒ `function-name-typo`
 *    **error**、纯未知 ⇒ `function-name-unknown` **warning**，两档产物都逐字节原样（改写=零）；
 * 3. **fail-closed**：error 档存在即拒绝产字节 / 拒绝写盘（`compileToBytes` 抛 `SugarCompileError`），
 *    半成品进不了游戏——这是"名字不许静默进产物"的落地半边。
 *
 * 为什么不能一刀切把 warning 升 error（读数口径见 `unknown-name-tier.corpus.test.ts`）：真语料
 * `個人口上` 2,285 份 `.ERB` 里中文函数名调用形态 1,396 处，按基础库判据补 13 条恒等条目后
 * 仍有 526 处 / 311 名 / 158 文件落在两张表外，且其中绝大多数是合法写法 ⇒ 全升 = 数百条 error、
 * 一屏红；分级后同一张盘新增 0 条。本文件因此**既钉抓力也钉零误伤**：两字短名（`随意` / `随便` /
 * `参数`）与**恒等条目**的近邻（`SHOW_上半身内衣`↔`SHOW_下半身内衣`）是放宽判据后实测会误伤的
 * 10 处与 13 处来源，必须永远留在 warning 档。
 */
import { describe, expect, it } from 'vitest';
import type { KojoLibraryTable, SugarDiagnostic } from '@kojo/plugin-api';
import { createEratwLibraryTable } from '@kojo/plugin-eratw-adapter';
import { lowerExpression, type ExprContext } from '../src/expression';
import {
  suggestFunctionName,
  TYPO_EDIT_DISTANCE,
  TYPO_MAX_TAIL_LEN,
  TYPO_MIN_NAME_LEN,
} from '../src/system-functions';
import { compileToBytes } from '../src/compile';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

/** 与生产同构的基础库表（真 builder，杜绝"替身与实现形状不同构 ⇒ 空断言"） */
function libTable(): KojoLibraryTable {
  return createEratwLibraryTable(
    new Map([
      ['角色文本', 'CHARA_TEXT'],
      ['随机文本', 'TEXTR'],
      ['彩虹打印行', 'PRINT_RAINBOW2L'],
      ['计数器消息', 'EVENT_COUNTER_MESSAGE'],
      ['心形', 'HPH_PRINT'],
      ['呻吟文本生成', 'MOAN_CN_GEN'],
      // 恒等条目（基础库盘上名本身就是中文）：ZH-D1 收录批的形状，**不得**当升档候选
      ['充填率', '充填率'],
      ['SHOW_下半身内衣', 'SHOW_下半身内衣'],
    ]),
  );
}

function ctx(opts: { libraryTable?: KojoLibraryTable; sink?: SugarDiagnostic[] }): ExprContext {
  return {
    aliases: new Map(),
    dictionary: stubDict,
    ...(opts.libraryTable ? { libraryTable: opts.libraryTable } : {}),
    report: (d) => opts.sink?.push(d),
    loc: null,
  };
}

/* ==================== A. 判据本体：阈值逐条钉死 ==================== */

describe('suggestFunctionName · 升档判据（ZH-D1）', () => {
  it('阈值常量是本批口径（改数=改判据，必须连同语料读数一起复核）', () => {
    expect(TYPO_EDIT_DISTANCE).toBe(1);
    expect(TYPO_MIN_NAME_LEN).toBe(3);
    expect(TYPO_MAX_TAIL_LEN).toBe(2);
  });

  it('形状①：单字之差（系统表）→ 唯一候选，且给出原生名', () => {
    const c = suggestFunctionName('字符串常度', libTable());
    expect(c).toEqual({ name: '字符串长度', engineName: 'STRLENS' });
  });

  it('形状①：单字之差（adapter 基础库表）→ 唯一候选', () => {
    expect(suggestFunctionName('随机丈本', libTable())?.name).toBe('随机文本');
    expect(suggestFunctionName('角色文苯', libTable())?.engineName).toBe('CHARA_TEXT');
  });

  it('形状②：写短了（尾巴 1～2 字）→ 候选；尾巴 ≥ 3 字 → 不算截断', () => {
    expect(suggestFunctionName('彩虹打印', libTable())?.name).toBe('彩虹打印行'); // 尾 2：仅靠形状②
    expect(suggestFunctionName('计数器消', libTable())?.name).toBe('计数器消息'); // 尾 2
    expect(suggestFunctionName('呻吟文', libTable())).toBeUndefined(); // 尾 3 ⇒ 视为另一个函数
  });

  it('歧义（近名 ≥ 2）→ 不猜、不升档（与 `bit-name-unknown` 同一口径）', () => {
    // `最苵值` 距系统表 `最大值` 与 `最小值` 都是 1
    expect(suggestFunctionName('最苵值', libTable())).toBeUndefined();
  });

  it('两字短名一律不升档（语料实测的 10 处误伤源，永久钉在 warning 档）', () => {
    for (const written of ['随意', '随便', '参数']) {
      expect(suggestFunctionName(written, libTable()), `「${written}」是合法自定义名，不得判成拼错`).toBeUndefined();
    }
  });

  it('恒等条目（盘上名本身就是中文/日文的函数）**不作候选**——语料实测 13 处误伤的来源', () => {
    // 基础库里成对存在"一字之差的双生真函数"：`SHOW_下半身内衣`↔`SHOW_上半身内衣`、
    // `仕事中チェック`↔`仕事日チェック`、`金額表示`↔`金额表示`。它们若进候选池，合法的
    // `SHOW_上半身内衣(…)` 就被判拼错并打死整棵能跑通的口上 ⇒ 候选只取别名条目。
    expect(suggestFunctionName('SHOW_上半身内衣', libTable())).toBeUndefined();
    expect(suggestFunctionName('充填卒', libTable())).toBeUndefined();
  });

  it('作者名更长（≥ 2 字）⇒ 视为另一个函数，不反查短名', () => {
    expect(suggestFunctionName('角色文本消息', libTable())).toBeUndefined();
  });

  it('恒等条目（盘上中文/日文名函数）不作候选——"一字之差的双生真函数"不得判拼错', () => {
    // `充填率` 是基础库里的**恒等**条目；`充填卒` 与它只差一个字，但这类近邻在语料里
    // 成对存在（`脱衣处理`↔`脱衣処理`、`SHOW_下…`↔`SHOW_上…`），判 error 会打死合法口上
    expect(suggestFunctionName('充填卒', libTable())).toBeUndefined();
  });

  it('已收录的名字没有候选（只有表外名进本判据）', () => {
    expect(suggestFunctionName('随机文本', libTable())).toBeUndefined();
    expect(suggestFunctionName('字符串长度', libTable())).toBeUndefined();
  });

  it('无 adapter 表时仅按系统表裁决（未打开工程不误伤、也不放水）', () => {
    expect(suggestFunctionName('字符串常度')?.name).toBe('字符串长度');
    expect(suggestFunctionName('随机丈本')).toBeUndefined(); // 表里没有 `随机文本`（那是基础库名）
  });
});

/* ==================== B. 生效点：两档诊断 + 产物逐字节原样 ==================== */

describe('lowerExpression · 中文调用形态的两档诊断', () => {
  it('唯一近名 → `function-name-typo` error，产物仍逐字节原样（改写=零）', () => {
    const sink: SugarDiagnostic[] = [];
    const out = lowerExpression('字符串常度(1)', ctx({ libraryTable: libTable(), sink }));
    expect(out).toBe('字符串常度(1)');
    const d = sink.filter((x) => x.code === 'function-name-typo');
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe('error');
    expect(sink.some((x) => x.code === 'function-name-unknown')).toBe(false); // 两档互斥，不重复报
    // 文案给的是"唯一那一个改法"，作者照做即可（全中文、含中文名与原生名）
    expect(d[0]!.message).toContain('「字符串长度」');
    expect(d[0]!.message).toContain('STRLENS');
  });

  it('纯未知（无近名）→ 维持 `function-name-unknown` warning，产物原样', () => {
    const sink: SugarDiagnostic[] = [];
    const out = lowerExpression('材料設定(1)', ctx({ libraryTable: libTable(), sink }));
    expect(out).toBe('材料設定(1)');
    expect(sink.filter((x) => x.code === 'function-name-unknown')).toHaveLength(1);
    expect(sink.find((x) => x.code === 'function-name-unknown')!.severity).toBe('warning');
    expect(sink.some((x) => x.code === 'function-name-typo')).toBe(false);
  });

  it('歧义（多近名）→ 只报 warning，不替作者选一个改法', () => {
    const sink: SugarDiagnostic[] = [];
    lowerExpression('最苵值(1)', ctx({ libraryTable: libTable(), sink }));
    expect(sink.filter((x) => x.code === 'function-name-unknown')).toHaveLength(1);
    expect(sink.filter((x) => x.code === 'function-name-typo')).toHaveLength(0);
  });

  it('负测：裸中文词 / 字符串字面量 / 前导标识符不产本批任一档诊断', () => {
    const sink: SugarDiagnostic[] = [];
    lowerExpression('"字符串常度(1)"', ctx({ libraryTable: libTable(), sink }));
    lowerExpression('她的字符串常度(1)', ctx({ libraryTable: libTable(), sink }));
    expect(sink.filter((x) => x.code === 'function-name-typo' || x.code === 'function-name-unknown')).toHaveLength(0);
  });
});

/* ==================== C. fail-closed：error 档拒绝产字节 ==================== */

describe('compileToBytes · error 档拒绝产字节（半成品不进游戏）', () => {
  const svc = () =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable(), libraryTable: libTable() });
  const doc = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;

  it('拼错名（唯一近名）→ 抛 SugarCompileError，不返回字节', () => {
    const src = doc('    如果 字符串常度(1) == 1：\n        「涩涩的话」\n');
    const diags = svc().transpile(src).diagnostics;
    expect(diags.filter((d) => d.code === 'function-name-typo' && d.severity === 'error')).toHaveLength(1);
    expect(() => compileToBytes(svc().transpile, src)).toThrow(/编译被拒绝/);
  });

  it('纯未知名（warning 档）→ 照旧产字节，产物逐字节含原名（不阻断真实自定义函数）', () => {
    const src = doc('    如果 材料設定(1) == 1：\n        「涩涩的话」\n');
    const bytes = compileToBytes(svc().transpile, src);
    expect(new TextDecoder().decode(bytes.bytes)).toContain('材料設定(1)');
  });
});

/* ==================== D. per-file 合并表也要有候选池（函数块文件不许漏） ==================== */

describe('声明了 `函数` 块的文件 · 升档判据不失效', () => {
  const svc = () =>
    createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable(), libraryTable: libTable() });

  it('本文件自定义函数的拼错名同样升 error（`names()` 透传在合并表上不能缺）', () => {
    const src =
      '角色: 12\n函数 打招呼(次数)：\n    「嗨。」\n    返回\n' +
      '时机 指令 310：\n    如果 打招乎(1) == 1：\n        「涩涩的话」\n';
    const diags = svc().transpile(src).diagnostics;
    const typo = diags.filter((d) => d.code === 'function-name-typo');
    expect(typo).toHaveLength(1);
    expect(typo[0]!.severity).toBe('error');
    expect(typo[0]!.message).toContain('「打招呼」');
  });

  it('正确写名的调用零诊断（合并表认得本函数的作者名，产物走既有降糖链）', () => {
    const src =
      '角色: 12\n函数 打招呼(次数)：\n    「嗨。」\n    返回\n' +
      '时机 指令 310：\n    如果 打招呼(1) == 1：\n        「涩涩的话」\n';
    const diags = svc().transpile(src).diagnostics;
    expect(diags.filter((d) => d.code === 'function-name-typo' || d.code === 'function-name-unknown')).toEqual([]);
  });
});
