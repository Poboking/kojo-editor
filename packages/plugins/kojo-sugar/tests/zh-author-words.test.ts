/**
 * ZH-E 线 · 表达式中文层补齐（zh-author-words）。
 *
 * 本文件钉住 `keywords.ts` 全中文化 ZH-E 批的四组判据（BOARD §Z ZH-E）：
 *
 * ① `随机形` / `直出` / `选择器` / `等待` 进 `KEYWORDS` **单一真源**（高亮/补全可见），
 *    但**不进 `HEAD_DECL_KEYS`**——判定全部留在 lexer/parser 的位置式扫描。
 *    负自证口径（"改坏一行看哪条红"）：这三个非 `随机形` 的词若被误挂进 `HEAD_DECL_KEYS`，
 *    行首 `词: 值` 通路会改走 `headDecl`，而 `parser.applyHeadDecl` 对未知键是
 *    **`default: 静默吞掉`**——本文件里"顶格裸写报 `indent-mismatch`"的用例就会红
 *    （error 消失 = fail-visible 变 fail-silent）。
 * ② `等待` / `wait` 双词形**非对称**：中文主形进词表（编辑器可见），英文形 `wait` 刻意
 *    不进（它是引擎指令 `WAIT` 的小写形；进糖表 = 把引擎名当糖关键字挂出来）；
 *    但 `wait` 在 `WAIT_MARKS` 里照常生效——两条面互不干扰。
 * ③ `真` / `假` / `空` / `异或` 中文运算符主形降糖 + **长词优先序不打乱**。
 * ④ **产物逐字节不变**：词表登记零产物足迹（既不以旧字节口径可证性论——既有 golden
 *    套件全体通过即"存量产物不变"的回归证据），新词形输入的产物必须与**引擎记号**写法
 *    （`CASE 1 TO 3` / `XOR` / `true` / `wait` 形）**逐字节相等**。
 *
 * 既有判据不破：`随机` 既是块头（`block.random`）又是族头（字典侧），本批未触碰——
 * 用 `lookupKeyword('随机')` + `随机形` 与 `随机：` 同文档共存两用例钉住。
 */

import { describe, expect, it } from 'vitest';
import { createSugarTranspileService } from '../src/service';
import {
  HEAD_DECL_KEYS,
  SUGAR_LEXICON_OPERATORS,
  SUGAR_LEXICON_WORDS,
  WAIT_MARKS,
  lookupKeyword,
  operatorTable,
  sugarEditorLexicon,
} from '../src/keywords';
import { stubDict, stubFaceTable } from './support';

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });
const t = (src: string) => svc().transpile(src);
const errCodes = (src: string): string[] =>
  t(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const trimmed = (src: string): string[] => t(src).erb.split('\n').map((l) => l.trim());

/** `角色:` + 时机块骨架（表达式断言用） */
const tm = (body: string): string => `角色: 12\n时机 指令 310：\n${body}\n`;

/* ============================== ① 四词形：词表可见、判定不变形 ============================== */

describe('ZH-E ①·四词形进 KEYWORDS 单一真源（随机形/直出/选择器/等待）', () => {
  it('四词形在表内且语义 id 正确', () => {
    expect(lookupKeyword('随机形')).toBe('head.randomShape');
    expect(lookupKeyword('直出')).toBe('head.randomShapeValue');
    expect(lookupKeyword('选择器')).toBe('head.selector');
    expect(lookupKeyword('等待')).toBe('inline.wait');
  });

  it('**不进 HEAD_DECL_KEYS**——头部声明集不收这四个 id（判定留在位置式扫描）', () => {
    for (const id of ['head.randomShape', 'head.randomShapeValue', 'head.selector', 'inline.wait']) {
      expect(HEAD_DECL_KEYS).not.toContain(id);
    }
  });

  it('负自证：裸写 `选择器: 2` / `等待: x` / `直出: x` 顶格一两报 `indent-mismatch`（不被 headDecl 静默吞掉）', () => {
    // 若有人把 `head.selector` / `inline.wait` / `head.randomShapeValue` 挂进
    // `HEAD_DECL_KEYS`，lexer 的 `词: 值` 通路会先于文本行退化截获它们，
    // `applyHeadDecl` 按 `default:` **静默吞掉** ⇒ 本用例的 error 消失 ⇒ 红。
    expect(errCodes('角色: 12\n选择器: 2\n时机 指令 310：\n\t「…」\n')).toContain('indent-mismatch');
    expect(errCodes('角色: 12\n等待: 啥\n时机 指令 310：\n\t「…」\n')).toContain('indent-mismatch');
    expect(errCodes('角色: 12\n直出: x\n时机 指令 310：\n\t「…」\n')).toContain('indent-mismatch');
  });

  it('编辑器词表聚合自动纳编四词形（ZH-L 的通道——sugarEditorLexicon 单一真源）', () => {
    const lex = sugarEditorLexicon();
    for (const [word, role] of [
      ['随机形', 'head'],
      ['直出', 'head'],
      ['选择器', 'head'],
      ['等待', 'inline'],
    ] as const) {
      const hit = lex.words.find((w) => w.word === word);
      expect(hit, word).toBeDefined();
      expect(hit!.role, word).toBe(role);
      expect(hit!.primary, `${word} 是 CJK 主形`).toBe(true);
    }
    // SUGAR_LEXICON_WORDS 与 sugarEditorLexicon().words 同源（同一份数组）
    expect(SUGAR_LEXICON_WORDS.some((w) => w.word === '随机形')).toBe(true);
  });

  it('`随机形: 直出` → 随机块产物直出 `SELECTCASE RAND:n`（不占 LOCAL 槽）；非 `直出` 值 = 缺省形', () => {
    const direct = trimmed('角色: 12\n随机形: 直出\n时机 绝顶：\n\t随机：\n\t\t「甲」\n\t\t「乙」\n');
    expect(direct).toContain('SELECTCASE RAND:2');
    expect(direct.some((l) => l.startsWith('LOCAL = RAND'))).toBe(false);

    const dflt = trimmed('角色: 12\n随机形: 粗体\n时机 绝顶：\n\t随机：\n\t\t「甲」\n\t\t「乙」\n');
    expect(dflt).toContain('LOCAL = RAND:2');
    expect(dflt).toContain('SELECTCASE LOCAL');
    expect(dflt).not.toContain('SELECTCASE RAND:2');
  });
});

/* ====================== ② `等待` / `wait` 双词形的非对称口径 ====================== */

describe('ZH-E ②·等待/wait 非对称（中文进表、引擎形不进）', () => {
  it('`WAIT_MARKS` 里两形都在（判定侧双收），但 `wait` 不进 `KEYWORDS`（词表侧不对称）', () => {
    expect(WAIT_MARKS).toContain('等待');
    expect(WAIT_MARKS).toContain('wait');
    expect(lookupKeyword('等待')).toBe('inline.wait');
    expect(lookupKeyword('wait')).toBeUndefined();
    expect(SUGAR_LEXICON_WORDS.some((w) => w.word === 'wait')).toBe(false);
  });

  it('`空行 等待` 与 `空行 wait` 产物**逐字节相同**（判定靠 WAIT_MARKS，不靠词表）', () => {
    const cn = t(tm('\t空行 等待\n\t空行\n'));
    const en = t(tm('\t空行 wait\n\t空行\n'));
    expect(cn.erb).toEqual(en.erb);
    expect(cn.erb.split('\n').map((l) => l.trim())).toContain('PRINTFORMDW');
  });

  it('`空行`（裸）不等待 → 裸 `PRINTFORML`（v1.5 口径不被本批改动）', () => {
    const lines = trimmed(tm('\t空行\n'));
    expect(lines).toContain('PRINTFORML');
  });
});

/* ==================== ③ 运算符中文主形（真/假/空/异或）+ 长词优先 ==================== */

describe('ZH-E ③·运算符中文主形降糖', () => {
  it('长词优先序不被新增词条打乱（全表逐项钉死：长度降序、同长保持书写序）', () => {
    expect(operatorTable().map(([zh]) => zh)).toEqual([
      '不等于',
      '异或',
      '等于',
      '超过',
      '至少',
      '不足',
      '至多',
      '且',
      '或',
      '非',
      '真',
      '假',
      '空',
    ]);
  });

  it('`异或` → XOR', () => {
    expect(trimmed(tm('\t如果 FLAG:1 异或 FLAG:2：\n\t\t「…」\n'))).toContain('IF FLAG:1 XOR FLAG:2');
  });

  it('`真` / `假` / `空` 逐字降糖（产物恒引擎记号）', () => {
    expect(trimmed(tm('\t如果 FLAG:1 等于 真：\n\t\t「…」\n'))).toContain('IF FLAG:1 == true');
    expect(trimmed(tm('\t如果 FLAG:1 等于 假：\n\t\t「…」\n'))).toContain('IF FLAG:1 == false');
    expect(trimmed(tm('\t如果 FLAG:1 等于 空：\n\t\t「…」\n'))).toContain('IF FLAG:1 == null');
  });

  it('双收对称：中文主形与引擎记号两种写法产物**逐字节相同**', () => {
    expect(t(tm('\t如果 FLAG:1 等于 真：\n\t\t「…」\n')).erb).toEqual(
      t(tm('\t如果 FLAG:1 == true：\n\t\t「…」\n')).erb,
    );
    expect(t(tm('\t如果 FLAG:1 异或 FLAG:2：\n\t\t「…」\n')).erb).toEqual(
      t(tm('\t如果 FLAG:1 XOR FLAG:2：\n\t\t「…」\n')).erb,
    );
  });

  it('长词优先：`不等于 真` → `!= true`（不被拆成 `非` + `等于`，也不产 `! =`）', () => {
    const lines = trimmed(tm('\t如果 FLAG:1 不等于 真：\n\t\t「…」\n'));
    expect(lines).toContain('IF FLAG:1 != true');
    expect(lines.join('\n')).not.toMatch(/! =/);
    // 与引擎记号写法逐字节相同（双收对称再钉一条）
    expect(t(tm('\t如果 FLAG:1 不等于 真：\n\t\t「…」\n')).erb).toEqual(
      t(tm('\t如果 FLAG:1 != true：\n\t\t「…」\n')).erb,
    );
  });

  it('词边界不误伤：`变量名异或`（贴词）不替换、照常报 `unknown-identifier`（不静默）', () => {
    const lines = trimmed(tm('\t如果 变量名异或：\n\t\t「…」\n'));
    expect(lines).toContain('IF 变量名异或');
    expect(errCodes(tm('\t如果 变量名异或：\n\t\t「…」\n'))).toContain('unknown-identifier');
  });

  it('编辑器词表聚合自动纳编新运算符（ZH-L 通道）', () => {
    for (const zh of ['异或', '真', '假', '空']) {
      expect(SUGAR_LEXICON_OPERATORS, zh).toContain(zh);
      // 高亮/补全要认得：编辑器聚合里 operators 不在 words、是独立的一个面
      expect(sugarEditorLexicon().operators, zh).toContain(zh);
    }
  });
});

/* ============================== ④ 产物逐字节不变 ============================== */

describe('ZH-E ④·区间词 `到` 走结构通路（不在 OPERATORS），产物落引擎记号 TO', () => {
  it('块形 `是 1 到 3：` → `CASE 1 TO 3`（`到` 不进运算符表、由 parser/codegen 消费）', () => {
    const lines = trimmed('角色: 12\n时机 指令 310：\n\t当 RAND:3：\n\t\t是 0：\n\t\t\t「甲。」\n\t\t是 1 到 3：\n\t\t\t「乙。」\n');
    expect(lines).toContain('CASE 1 TO 3');
  });

  it('箭头形 `是 1 到 3 -> 0` → `CASE 1 TO 3`', () => {
    const src = '角色: 12\n时机 指令 310：\n\t她的心情 = 当 FLAG:1：\n\t\t是 1 到 3 -> 0\n\t\t否则 -> 1\n';
    expect(trimmed(src)).toContain('CASE 1 TO 3');
  });
});

describe('ZH-E ④·词表登记零产物足迹（同义形态产物逐字节相同）', () => {
  it('`口上: <家族> 选择器: 2` 与 `selector: 2` 尾缀产物逐字节相同（A1 批口径不变）', () => {
    const cn = t('角色: 12\n口上: 测试 选择器: 2\n时机 指令 310：\n\t「…」\n');
    const en = t('角色: 12\n口上: 测试 selector: 2\n时机 指令 310：\n\t「…」\n');
    expect(cn.erb).toEqual(en.erb);
  });

  it('`随机` 仍是块头（`block.random`）——`随机形` 登记不冒充、不冲突它', () => {
    expect(lookupKeyword('随机')).toBe('block.random');
    // 同文档共存：`随机形:` 开关 + `随机：` 块各归各位（① 已正检产物，这里再钉共存不串）
    expect(errCodes('角色: 12\n随机形: 直出\n时机 绝顶：\n\t随机：\n\t\t「甲」\n\t\t「乙」\n')).toEqual([]);
  });
});
