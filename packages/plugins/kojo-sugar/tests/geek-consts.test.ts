/**
 * 7 号批 · 文件级常量 `常量 <名> = <值>`（**宏化修订**：编译期展开，产物零引擎足迹）。
 *
 * 判据（本批）：
 * - 形态：`常量 <名> = <整数>`（英文别名 `const`，词后跟空白；`=` 两侧空白自由）；
 * - 产物：**不发射任何声明**——只落一行注释 `; 常量 <名> = <值>（编译期展开为字面量，
 *   不占引擎全局名）`，与既有 `@` 块产物共存、按源顺序稳定。理由：函数外的
 *   `#DIM CONST` 在 Emuera 里是**游戏级全局**，两个 `.kojo` 各写一个同名常量、或与
 *   语料既有 `.ERH` 全局名撞上 ⇒ 游戏**加载期**整体失败；而糖内所有引用早已字面量
 *   替换 ⇒ 该声明是死重，却占着唯一的引擎全局足迹与全部撞名面（详见 codegen.ts）。
 *   本文件用"产物里一条 `#DIM …` 声明都没有"钉死"零引擎足迹"。
 * - 同名可查：常量名以**只读数字别名**并入本文件别名表 ⇒ 裸名与 `CFLAG:11:<名>` 在
 *   表达式里都解析为数值（`expression.ts` §5.0 第 1 步）；**不另起一层字典**
 *   （既有「来源分层」字典建在 adapter/项目级 `.ERH` 上，容不下"本 `.kojo` 尚未编译
 *   就声明的常量"）。
 * - 冲突/残缺**复用既有诊断码、不静默**：保留代词或撞别名 → `alias-name-conflict`；
 *   撞字典已知变量名（宏化后的残余坑：文件内静默遮蔽）→ 同码；重名 → `alias-duplicate`；
 *   名/值残缺 → `alias-unknown-target`；写在时机之后 → `alias-not-in-header`。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import { SUGAR_LEXICON_WORDS } from '../src/keywords';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);

/** 产物按行展开（**保留缩进**——"顶格落注释"是本批铁律之一） */
const outLines = (src: string): string[] => t(src).erb.split('\n');
/** 产物按行展开、去缩进（表达式断言用） */
const trimmed = (src: string): string[] => outLines(src).map((l) => l.trim());
/** error 诊断的 code 列表 */
const errCodes = (src: string): string[] =>
  t(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
/** 产物里是否落了引擎声明（本批必须恒 false：常量改为编译期展开） */
const hasEngineDecl = (src: string): boolean =>
  outLines(src).some((l) => l.trimStart().startsWith('#DIM'));
/** 常量在产物里的那行注释（宏化后唯一的痕迹） */
const constLine = (name: string, value: string): string =>
  `; 常量 ${name} = ${value}（编译期展开为字面量，不占引擎全局名）`;

/** `角色:` + 常量区 + 一个时机块（让产物既有常量痕迹、又有 `@` 函数） */
const doc = (decls: string): string => `角色: 12\n${decls}\n时机 绝顶：\n\t「…」\n`;

/* ================================ 正向：产物形态 ================================ */

describe('7 号 · 常量宏化（正向：零引擎足迹）', () => {
  it('`常量 X = 1022` → 产物顶格一行注释，落在第一个 `@` 函数之前，且**零** `#DIM` 声明', () => {
    const src = doc('常量 X = 1022');
    expect(errCodes(src)).toEqual([]);
    const lines = outLines(src);
    const declIdx = lines.indexOf(constLine('X', '1022')); // 精确匹配 = 顶格（无缩进）
    const atIdx = lines.findIndex((l) => l.startsWith('@'));
    expect(declIdx).toBeGreaterThanOrEqual(0);
    expect(atIdx).toBeGreaterThan(declIdx); // 痕迹在函数定义之外（文件顶部区块）
    expect(hasEngineDecl(src)).toBe(false); // 撞引擎面构造性消失
  });

  it('同名常量写在两个文件里都零引擎足迹（"用户 × 用户"撞名不再可能）', () => {
    expect(hasEngineDecl(doc('常量 撞名 = 1'))).toBe(false);
    expect(hasEngineDecl(`角色: 13\n常量 撞名 = 2\n时机 绝顶：\n\t「…」\n`)).toBe(false);
  });

  it('多条常量按源顺序稳定落注释', () => {
    const lines = outLines(doc('常量 甲 = 1\n常量 乙 = 2'));
    const a = lines.indexOf(constLine('甲', '1'));
    const b = lines.indexOf(constLine('乙', '2'));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  it('英文别名 `const` 与 `常量` 等价（产物逐字节相同）', () => {
    expect(t(doc('const X = 1022')).erb).toEqual(t(doc('常量 X = 1022')).erb);
  });

  it('`=` 两侧空白自由：`常量 X=5` 与 `常量 X = 5` 产物相同', () => {
    expect(t(doc('常量 X=5')).erb).toEqual(t(doc('常量 X = 5')).erb);
  });

  it('负整数字面量照收', () => {
    expect(outLines(doc('常量 X = -5'))).toContain(constLine('X', '-5'));
  });

  it('`常量名`（词后无空白）不判为常量，按文本行打印（不误吞）', () => {
    const src = `角色: 12\n时机 绝顶：\n\t常量名是什么\n`;
    expect(errCodes(src)).toEqual([]);
    expect(outLines(src).some((l) => l.trimStart().startsWith('PRINTFORM') && l.includes('常量名是什么'))).toBe(true);
  });
});

/* ======================= 正向：常量名可被本文件表达式查到 ======================= */

describe('7 号 · 常量名在本文件表达式里解析为数值', () => {
  it('裸常量名：`如果 被下药次数 > 0：` → `IF 1022 > 0`', () => {
    const src = `角色: 12\n常量 被下药次数 = 1022\n时机 绝顶：\n\t如果 被下药次数 > 0：\n\t\t「…」\n`;
    expect(errCodes(src)).toEqual([]);
    expect(trimmed(src)).toContain('IF 1022 > 0');
  });

  it('`CFLAG:11:<常量名>` → `CFLAG:11:1022`（三段形，第三段是常量名）', () => {
    const src = `角色: 12\n常量 K11_被下药次数 = 1022\n时机 绝顶：\n\t如果 CFLAG:11:K11_被下药次数 >= 30：\n\t\t「…」\n`;
    expect(errCodes(src)).toEqual([]);
    expect(trimmed(src)).toContain('IF CFLAG:11:1022 >= 30');
  });

  it('常量是**只读**：出现在赋值左值 → `readonly-alias-assignment`（不静默）', () => {
    const src = `角色: 12\n常量 被下药次数 = 1\n时机 绝顶：\n\t被下药次数 = 5\n`;
    expect(errCodes(src)).toContain('readonly-alias-assignment');
  });
});

/* ============================ 冲突 / 残缺：不静默 ============================ */

describe('7 号 · 常量冲突与残缺（复用既有诊断码，闭集不扩）', () => {
  it('保留代词 `她` → `alias-name-conflict`', () => {
    expect(errCodes(doc('常量 她 = 5'))).toContain('alias-name-conflict');
  });

  it('与既有别名同名 → `alias-name-conflict`', () => {
    const src = `角色: 12\n别名 恋人 = CFLAG:TARGET:14\n常量 恋人 = 5\n时机 绝顶：\n\t「…」\n`;
    expect(errCodes(src)).toContain('alias-name-conflict');
  });

  it('常量重名 → `alias-duplicate`', () => {
    expect(errCodes(doc('常量 X = 1\n常量 X = 2'))).toContain('alias-duplicate');
  });

  it('值不是整数字面量 → `alias-unknown-target`，且**零引擎声明**', () => {
    const src = doc('常量 X = 恋人');
    expect(errCodes(src)).toContain('alias-unknown-target');
    expect(hasEngineDecl(src)).toBe(false);
    expect(outLines(src)).not.toContain(constLine('X', '恋人'));
  });

  it('缺 `=`（残缺）→ `alias-unknown-target`，且**零引擎声明**', () => {
    const src = doc('常量 X 1022');
    expect(errCodes(src)).toContain('alias-unknown-target');
    expect(hasEngineDecl(src)).toBe(false);
  });

  it('写在时机块之后 → `alias-not-in-header`', () => {
    const src = `角色: 12\n时机 绝顶：\n\t「…」\n常量 X = 1\n`;
    expect(errCodes(src)).toContain('alias-not-in-header');
  });

  it('**宏化后的残余坑**：常量名撞字典已知变量 → `alias-name-conflict`（否则本文件静默遮蔽）', () => {
    expect(errCodes(doc('常量 好感度 = 5'))).toContain('alias-name-conflict');
    expect(errCodes(doc('常量 心情 = 5'))).toContain('alias-name-conflict'); // 走同一码
  });

  it('字典不认识的常量名照常放行（守门不误伤）', () => {
    expect(errCodes(doc('常量 我的阈值 = 5'))).toEqual([]);
  });
});

/* ================================ 与既有面共存 ================================ */

describe('7 号 · 与既有 `@` 块产物共存', () => {
  it('顶层原生 `@` 块仍原样透传，常量痕迹排在其前（函数外区块）', () => {
    const src = `角色: 12\n常量 X = 1\n@MY_RAW\n\t#DIM Y\n\tRETURN\n`;
    const lines = outLines(src);
    const declIdx = lines.indexOf(constLine('X', '1'));
    const rawIdx = lines.indexOf('@MY_RAW');
    expect(declIdx).toBeGreaterThanOrEqual(0);
    expect(rawIdx).toBeGreaterThan(declIdx);
    expect(lines).toContain('\t#DIM Y'); // 原生块逐行原样透传（缩进保留）
    // 直通块里的 `#DIM` 是作者手写的，不在本批"零引擎足迹"的管辖内（常量自身不产声明）
    expect(lines.filter((l) => l.trimStart().startsWith('#DIM'))).toEqual(['\t#DIM Y']);
  });
});

/* ================================ 编辑器词表 ================================ */

describe('7 号 · 关键字登记进词表（高亮/补全单一真源）', () => {
  it('`常量` / `const` 在 `SUGAR_LEXICON_WORDS` 里（role=head，中文主形 primary）', () => {
    for (const w of ['常量', 'const']) {
      const hit = SUGAR_LEXICON_WORDS.find((x) => x.word === w);
      expect(hit, `${w} 未登记`).toBeDefined();
      expect(hit!.id).toBe('head.const');
      expect(hit!.role).toBe('head');
    }
    expect(SUGAR_LEXICON_WORDS.find((x) => x.word === '常量')!.primary).toBe(true);
    expect(SUGAR_LEXICON_WORDS.find((x) => x.word === 'const')!.primary).toBe(false);
  });

  it('登记进词表**不改判定**：`常量 X = 5` 仍走常量通路（落注释、零 `#DIM`），不进 `headDecl`', () => {
    const src = doc('常量 X = 5');
    expect(errCodes(src)).toEqual([]);
    expect(outLines(src)).toContain(constLine('X', '5'));
    expect(hasEngineDecl(src)).toBe(false);
    // 若被 `词: 值` 通路截半，产物里会出现把 `=` 前那截当头部值的怪东西（`X = 5` 裸行）
    expect(trimmed(src).some((l) => /^X\s*=/.test(l))).toBe(false);
  });
});
