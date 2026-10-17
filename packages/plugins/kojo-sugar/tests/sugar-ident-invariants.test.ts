/**
 * W5 LIFT-PROJ-ALIGN 的**验收核心**：识别口径并一之后，写回侧（`lift.ts`）与显示侧
 * （`project.ts`）必须从**同一张表**（`sugar-ident.ts`）派生，用途差异只做成药丸上的
 * 标志位（`writable` / `displayable`），**不许再出现第二份规则表**。
 *
 * 三组测试：
 *
 * 1. **源码级反分叉闸门**——直接在 `lift.ts` / `project.ts` 的文本里搜"第二份表"的影子
 *    （本地 `PRINT_VARIANTS` / `SUGAR_CONTROL` / `UNSUPPORTED_FLOW` / `PRINT_FAMILY_RE`…）。
 *    表一旦被重新抄一份，本条立刻红——这条比任何注释都可靠。
 * 2. **六个形态双向各钉**——`PRINTL` / 空行 / 行内三元 / `SIF` / 代词 / `alias`：
 *    显示侧钉"投成了什么"，建议侧钉"出候选（并附逐字节自证）或给明确拒绝理由"，
 *    两侧都**只显不写**的形态必须带一条**负自证**（真去转译一次，证明产物对不上）。
 * 3. **总不变量**——逐行走一遍：`displayable ⇒ 有候选 ∥ 有明确理由`（不许静默）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarLiftResult } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { parseExpression } from '@kojo/plugin-condition-extractor';
import { createSugarTranspileService } from '../src/service';
import { liftSuggest } from '../src/lift';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import type { DictionaryLookup } from '../src/types';
import { stubFaceTable } from './support';
import {
  ALIAS_DISPLAYABLE,
  ALIAS_WRITABLE,
  ATTRIBUTE_WRITABLE,
  CONTROL_SHAPES,
  FACE_HEAD_WRITABLE,
  NAME_ALIAS_WRITABLE,
  PRONOUN_WRITABLE,
  PRINT_VARIANTS,
  controlHeadText,
  singleIfSugar,
  unsupportedInBlock,
  writableControl,
  writablePrint,
} from '../src/sugar-ident';

/* ============================== 装配 ============================== */

/** 行内条件记号（反斜杠 + `@`）——`String.raw` 只为把这两个字符原样带进字符串 */
const B = String.raw`\@`;

/** 认得的属性字典（`nameAt` = 反糖要用的反向查询；住测试，不住生产） */
const namedDict: DictionaryLookup = {
  resolveFamily(name) {
    if (name === '好感度' || name === '心情') return 'CFLAG';
    if (name === '胆怯' || name === '恋慕') return 'TALENT';
    return undefined;
  },
  resolve(ident) {
    const head = ident.split(':')[0]!.toUpperCase();
    return ['CFLAG', 'TALENT', 'ABL', 'EXP', 'MARK', 'BASE', 'PALAM', 'TEQUIP', 'TCVAR'].includes(head)
      ? ident
      : undefined;
  },
  nameAt(family, index) {
    return family === 'CFLAG' && index === '1088' ? '好感度' : undefined;
  },
};

const transpile = (source: string) =>
  createSugarTranspileService({ dictionary: namedDict, faceTable: stubFaceTable() }).transpile(source);

/** 建议侧（写回口径）：真转译 + 真扫描 + 真表达式解析 */
const liftDeps = (dictionary?: DictionaryLookup): LiftDeps => ({
  transpile,
  scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
  parseCondition: (t: string) => parseExpression(t),
  ...(dictionary ? { dictionary: () => dictionary } : {}),
});

/** 显示侧（投影口径）：`transpile` 用**抛错替身**——投影一次都不许调用自证 */
const projDeps = (dictionary?: DictionaryLookup): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不该调用 transpile');
  },
  scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
  ...(dictionary ? { dictionary: () => dictionary } : {}),
});

/** 剥掉公共基准缩进（= `lift.ts` 比对的同一把尺子：绝对缩进不可比、相对缩进才可比） */
const dedent = (text: string): string => {
  const ls = text.split('\n');
  let min = Number.POSITIVE_INFINITY;
  for (const l of ls) if (l.trim().length > 0) min = Math.min(min, l.length - l.trimStart().length);
  if (!Number.isFinite(min)) return text;
  return ls.map((l) => (l.trim().length === 0 ? '' : l.slice(min))).join('\n');
};

const lift = (source: string, dictionary?: DictionaryLookup): SugarLiftResult =>
  liftSuggest(liftDeps(dictionary), { source, characterNo: 1 });

/** 投影出来第 1 行的糖文本（没有段 = 该行保留原生） */
const projectedAt = (source: string, line = 1, dictionary?: DictionaryLookup): string | undefined => {
  const { segments } = liftProject(projDeps(dictionary), { source });
  const seg = segments.find((s) => line >= s.fromLine && line <= s.toLine);
  if (seg === undefined) return undefined;
  return seg.sugarText.split('\n')[line - seg.fromLine];
};

/** 建议侧是否**答过**这一行（出候选 or 记跳过——两者皆无 = 静默，违铁律） */
const answeredAt = (r: SugarLiftResult, line: number): boolean =>
  r.candidates.some((c) => line >= c.fromLine && line <= c.toLine) ||
  r.skipped.some((s) => line >= s.fromLine && line <= s.toLine);

/** 把一行糖塞进最小 `.kojo` 真转译一次（负自证用：证明"只显不写"是真做不到，不是偷懒） */
const shell = (body: string, extraHead = ''): string =>
  transpile(`角色: 1\n${extraHead}时机 指令 1：\n\t${body}\n`).erb;

/* ============================== 一、反分叉闸门 ============================== */

describe('W5 / 识别表只有一份（源码级闸门）', () => {
  const here = import.meta.dirname;
  const read = (f: string): string => fs.readFileSync(path.resolve(here, '..', 'src', f), 'utf8');
  /** 只看代码不看散文：块注释 / 行注释里**提**旧名单的名字是允许的，重新**定义**才要红 */
  const codeOnly = (src: string): string =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
  const readCode = (f: string): string => codeOnly(read(f));

  it('lift.ts 里不再自带 PRINT 表 / 控制流名单 / PRINT 正则', () => {
    const src = readCode('lift.ts');
    for (const forbidden of [
      'const PRINT_VARIANTS',
      'interface PrintVariant',
      'const PRINT_FAMILY_RE',
      'UNSUPPORTED_FLOW',
      'const ALIAS_MIN_OCCURRENCES',
      'const VAR_REF_RE',
      'function hasInlineCondition',
      'function splitTopLevel',
      'function contentOf(',
      'function indentOf(',
      'function leadingWord(',
    ]) {
      expect(src, `lift.ts 仍含第二份：${forbidden}`).not.toContain(forbidden);
    }
  });

  it('project.ts 里不再自带 PRINT 表 / 糖块头表 / 开闭集合', () => {
    const src = readCode('project.ts');
    for (const forbidden of [
      'const PRINT_VARIANTS',
      'interface PrintVariant',
      'const PRINT_FAMILY_RE',
      'SUGAR_CONTROL',
      'const OPEN_PAIR',
      'const CLOSE_KINDS',
      'const NON_BODY_LINE_KINDS',
      'const TRY_CATCH_OPEN',
      'const TRY_LIST_OPEN',
      'function pairOf(',
      'function needsExpression(',
      'function hasInlineCondition',
      'function hasCommandColon',
      'function contentOf(',
      'function splitSourceLines(',
      'function branchText(',
      'inlineSpanToSugar',
    ]) {
      expect(src, `project.ts 仍含第二份：${forbidden}`).not.toContain(forbidden);
    }
  });

  it('两侧都从 sugar-ident 取表（import 里点名）', () => {
    for (const f of ['lift.ts', 'project.ts']) {
      expect(readCode(f)).toContain("from './sugar-ident'");
    }
  });

  it('表自洽：writable 集恰是规范 §5.1 的四个产物；displayable 集 = 表里全部', () => {
    const writable = [...PRINT_VARIANTS.values()].filter(writablePrint).map((v) => v.word);
    expect(writable).toEqual(['PRINTFORMW', 'PRINTFORML', 'PRINTFORMDW', 'PRINTFORMDL']);
    // 显示口径 = 「在表里」：比写回口径多 8 个（非 FORM 系 + 裸 FORM 片段）
    expect([...PRINT_VARIANTS.keys()]).toHaveLength(12);
    expect(PRINT_VARIANTS.has('PRINTBUTTON')).toBe(false); // 表外：两侧都不动
  });

  it('控制流表自洽：role ⇔ 显示/写回两个谓词', () => {
    for (const [kind, shape] of CONTROL_SHAPES) {
      const top = writableControl(kind);
      const inside = writableControl(kind, 'inside-block');
      switch (shape.role) {
        case 'block-head':
          expect(top).toBe('block');
          expect(inside).toBe('block');
          expect(unsupportedInBlock(kind)).toBe(false);
          break;
        case 'single-line-head':
          expect(top).toBe('single-line');
          expect(inside).toBeNull(); // 块内仍按"糖未覆盖"处理
          expect(unsupportedInBlock(kind)).toBe(true);
          break;
        case 'branch':
        case 'sugar-close':
          expect(top).toBeNull();
          expect(unsupportedInBlock(kind)).toBe(false);
          break;
        default:
          expect(top).toBeNull();
          expect(unsupportedInBlock(kind)).toBe(true);
          expect(shape.head).toBeUndefined();
      }
      // 表里没有收束词的块开词，配对闭合词必须给得出
      if (shape.closeWord !== undefined) expect(controlHeadText(kind, 'X')).toBeTypeOf('string');
    }
  });

  it('块头文本只有一个来源：投影出的块头 === 表里的串', () => {
    for (const [kind, erbLine] of [
      ['IF', 'IF CFLAG:2 >= 50'],
      ['ELSEIF', 'ELSEIF CFLAG:2 >= 30'],
      ['SELECTCASE', 'SELECTCASE TFLAG:193'],
    ] as const) {
      const src = [erbLine, '\tPRINTFORMDW 甲。', kind === 'SELECTCASE' ? 'ENDSELECT' : 'ENDIF'].join('\n');
      expect(projectedAt(src)).toBe(controlHeadText(kind, erbLine.slice(kind.length + 1)));
    }
    expect(controlHeadText('ELSE', '')).toBe('否则：');
    expect(controlHeadText('ENDIF', '')).toBeUndefined(); // 收束行：被缩进吸收，不产出可见行
    expect(controlHeadText('CASE', '1')).toBe('是 1：');
  });
});

/* ============================== 二、六个形态，双向各钉 ============================== */

describe('W5 / 形态 1：PRINTL（非 FORM 文本行）—— 只显不写', () => {
  const src = 'PRINTL 普通打印';

  it('显示侧：投成文本行（L 后缀 → 行尾 ` 续`）', () => {
    expect(projectedAt(src)).toBe('普通打印 续');
  });

  it('建议侧：无候选，但给出**由表派生**的明确拒绝理由（不静默）', () => {
    const r = lift(src);
    expect(r.candidates).toHaveLength(0);
    expect(answeredAt(r, 1)).toBe(true);
    expect(r.skipped[0]!.reason).toBe('unsupported-print-variant');
    expect(r.skipped[0]!.message).toContain('不是 FORM');
    expect(writablePrint(PRINT_VARIANTS.get('PRINTL')!)).toBe(false);
  });

  it('负自证：把投出来的糖写法真去转译 → 产物是 FORM 系，**必然**不是 PRINTL', () => {
    const erb = shell('普通打印 续');
    expect(erb).toMatch(/PRINTFORM[DL]?/);
    expect(erb).not.toMatch(/(^|\s)PRINTL(\s|$)/);
  });
});

describe('W5 / 形态 2：空行（裸指令打空行）—— 两种节奏可写、其余只显', () => {
  it('显示侧：`newline` 变体的空体一律投成 `空行` / `空行 等待`', () => {
    expect(projectedAt('PRINTFORML')).toBe('空行');
    expect(projectedAt('PRINTFORMDW')).toBe('空行 等待');
    expect(projectedAt('PRINTL')).toBe('空行'); // 非 FORM：能看，不能写
  });

  it('建议侧：糖的空行形态**恰好**产的那两个变体出候选（逐字节自证）', () => {
    for (const [src, sugar] of [
      ['PRINTFORML', '空行'],
      ['PRINTFORMDW', '空行 等待'],
    ] as const) {
      const c = lift(src).candidates[0]!;
      expect(c.kind).toBe('print-message');
      expect(c.sugarSource).toBe(sugar);
      expect(c.roundTrip.verified).toBe(true);
      expect(dedent(c.roundTrip.generatedText)).toBe(src);
    }
  });

  it('建议侧：写不回的两种空体也各有明确理由', () => {
    const nonForm = lift('PRINTL');
    expect(nonForm.candidates).toHaveLength(0);
    expect(nonForm.skipped[0]!.reason).toBe('unsupported-print-variant');

    const wrongWait = lift('PRINTFORMW'); // `空行 等待` 恒产 PRINTFORMDW ⇒ 必然不等
    expect(wrongWait.candidates).toHaveLength(0);
    expect(wrongWait.skipped[0]!.reason).toBe('roundtrip-mismatch');
  });

  it('负自证：空行的产物形态是**固定的两个**（据此可证明另两种不可能自证）', () => {
    expect(shell('空行')).toMatch(/PRINTFORML/);
    expect(shell('空行 等待')).toMatch(/PRINTFORMDW/);
    expect(shell('空行')).not.toMatch(/PRINTFORMW(\s|$)/);
  });
});

describe('W5 / 形态 3：行内三元 —— 两侧同一个拆段核', () => {
  const src = `PRINTFORMW 她${B}CFLAG:2 >= 50?甲#乙${B}看着你。`;
  const sugar = '她{CFLAG:2 >= 50 ? "甲" : "乙"}看着你。';

  it('显示侧：投成糖三元', () => {
    expect(projectedAt(src)).toBe(sugar);
  });

  it('建议侧：出候选，且糖写法与显示**逐字相同**、round-trip 自证通过', () => {
    const r = lift(src);
    const c = r.candidates[0]!;
    expect(c.sugarSource).toBe(sugar);
    expect(c.roundTrip.verified).toBe(true);
    expect(dedent(c.roundTrip.generatedText)).toBe(src);
  });

  it('负向钉：三段拆不出 → 显示整行不动、建议给明确理由（两侧都不猜）', () => {
    const broken = `PRINTFORML 前半 ${B} A ? x ${B} 后半`; // 缺 `#`（假分支）
    expect(liftProject(projDeps(), { source: broken }).segments).toHaveLength(0);
    const r = lift(broken);
    expect(r.candidates).toHaveLength(0);
    expect(answeredAt(r, 1)).toBe(true);
    expect(r.skipped[0]!.reason).toBe('not-covered');
  });
});

describe('W5 / 形态 4：SIF —— 显示成块头、写回成单行「则」', () => {
  const indented = `SIF CFLAG:2 >= 50\n\tPRINTFORMDW 甲。`;
  const flat = `SIF CFLAG:2 >= 50\nPRINTFORMDW 甲。`;

  it('显示侧：两种正文形态都投成「如果 …：」块头（表里的 role = single-line-head）', () => {
    expect(projectedAt(indented)).toBe(controlHeadText('IF', 'CFLAG:2 >= 50'));
    expect(projectedAt(flat)).toBe(controlHeadText('IF', 'CFLAG:2 >= 50'));
    expect(controlHeadText('SIF', 'X')).toBeUndefined(); // 通用块头通道**不接** SIF（planSif 专管）
  });

  it('建议侧：正文缩进一级时出候选（`如果 … 则 …`）并自证', () => {
    const c = lift(indented).candidates.find((x) => x.fromLine === 1)!;
    expect(c.kind).toBe('if-block');
    expect(c.toLine).toBe(2);
    expect(c.sugarSource).toBe(singleIfSugar('CFLAG:2 >= 50', '甲。'));
    expect(c.roundTrip.verified).toBe(true);
    expect(dedent(c.roundTrip.generatedText)).toBe(indented);
  });

  it('建议侧：平级正文（语料主流写法）给明确理由，不静默', () => {
    const r = lift(flat);
    expect(r.candidates.filter((c) => c.fromLine === 1)).toHaveLength(0);
    expect(answeredAt(r, 1)).toBe(true);
    expect(r.skipped.some((s) => s.reason === 'roundtrip-mismatch' && s.message.includes('缩进'))).toBe(true);
  });

  it('负自证：单行条件的产物**恒**把正文缩进一级 ⇒ 平级源文件不可能逐字节还原', () => {
    const lines = shell('如果 CFLAG:2 >= 50 则 甲。').split('\n');
    const at = lines.findIndex((l) => l.trim().startsWith('SIF '));
    expect(at).toBeGreaterThan(-1);
    const headIndent = lines[at]!.length - lines[at]!.trimStart().length;
    const bodyIndent = lines[at + 1]!.length - lines[at + 1]!.trimStart().length;
    expect(bodyIndent).toBe(headIndent + 1);
  });
});

describe('W5 / 形态 5：代词 —— 两侧同口径（写回也成立）', () => {
  const src = 'PRINTFORMW %CALLNAME:TARGET%来了。';

  it('显示侧：反糖成 `{她}`', () => {
    expect(projectedAt(src)).toBe('{她}来了。');
  });

  it('建议侧：候选糖写法与显示**逐字相同**且自证通过', () => {
    const c = lift(src).candidates[0]!;
    expect(c.sugarSource).toBe('{她}来了。');
    expect(c.roundTrip.verified).toBe(true);
    expect(dedent(c.roundTrip.generatedText)).toBe(src);
    expect(PRONOUN_WRITABLE).toBe(true);
  });

  it('属性反糖**只显不写**：显示投成 `{她的好感度}`，候选却保留 `%…%`', () => {
    const attr = 'PRINTFORMW 好感是 %CFLAG:TARGET:1088%。';
    expect(projectedAt(attr, 1, namedDict)).toBe('好感是 {她的好感度}。');
    const c = lift(attr, namedDict).candidates[0]!;
    expect(c.sugarSource).toBe('好感是 %CFLAG:TARGET:1088%。');
    expect(ATTRIBUTE_WRITABLE).toBe(false);
    expect(NAME_ALIAS_WRITABLE).toBe(false);
    // 负自证：真把显示出来的那行糖转译 → 定界符从 `%…%` 变成 `{…}` ⇒ 必然不等
    const erb = shell('好感是 {她的好感度}。');
    // 定界符换了（`%…%` → `{…}`）、索引也降成了名字 ⇒ 与原文 `好感是 %CFLAG:TARGET:1088%。`
    // 不可能逐字节相等 ⇒ 属性反糖**只能显示**（`ATTRIBUTE_WRITABLE = false`）
    expect(erb).toContain('好感是 {CFLAG:TARGET:好感度}。');
    expect(erb).not.toContain('%CFLAG:TARGET:1088%');
  });
});

describe('W5 / 形态 6：alias —— 两侧都不动，但建议侧照常报告', () => {
  const src = [
    `PRINTFORMDW 好感是 %CFLAG:TARGET:1088%。`,
    `PRINTFORMDW 再说一遍，好感是 %CFLAG:TARGET:1088%。`,
    `PRINTFORMDW 第三遍了，好感是 %CFLAG:TARGET:1088%。`,
  ].join('\n');

  it('建议侧：零候选 + 一条 `not-covered` 提示（不静默）', () => {
    const r = lift(src);
    expect(r.candidates.filter((c) => c.kind === 'alias')).toHaveLength(0);
    const note = r.skipped.find((s) => s.reason === 'not-covered' && s.message.includes('CFLAG:TARGET:1088'));
    expect(note).toBeDefined();
    expect(note!.message).toContain('3 次');
  });

  it('显示侧：别名是文件级声明、不是行糖 ⇒ 投影里一个「别名」都不出现', () => {
    const text = liftProject(projDeps(), { source: src })
      .segments.map((s) => s.sugarText)
      .join('\n');
    expect(text).not.toContain('别名');
    expect(ALIAS_DISPLAYABLE).toBe(false);
    expect(ALIAS_WRITABLE).toBe(false);
  });

  it('负自证：插值位上的别名写回**确实**对不上（定界符变了）；而赋值位上的别名展开恒等', () => {
    const decl = '别名 今天已触发 = CFLAG:TARGET:1088\n';
    // ① 百分号插值 → 别名：产物变成花括号形 ⇒ 与原 ERB 不等（这就是"无可验证落点"）
    expect(shell('好感是 {今天已触发}。', decl)).toContain('好感是 {CFLAG:TARGET:1088}。');
    // ② 对照：赋值位上的别名展开是恒等的 ⇒ 阻塞点不是"别名不生效"，
    //    而是它需要**额外**一行文件头声明，而候选模型只装"一个区间的替换"（见 lift-action 剔除 alias）
    expect(shell('今天已触发 = 1', decl)).toContain('CFLAG:TARGET:1088 = 1');
  });
});

/* ============================== 三、总不变量 ============================== */

describe('W5 / 不变量：displayable ⇒ 候选 ∥ 明确拒绝理由', () => {
  /** 覆盖六形态 + 表里全部 PRINT 变体的一批单行 / 多行输入 */
  const probes: string[] = [
    'PRINTFORMW 「你好。」',
    'PRINTFORML 「你好。」',
    'PRINTFORMDW 旁白。',
    'PRINTFORMDL 旁白。',
    'PRINTFORM 拼句片段',
    'PRINTFORMD 拼句旁白',
    'PRINTL 普通打印',
    'PRINTW 普通打印',
    'PRINTDL 普通打印',
    'PRINTDW 普通打印',
    'PRINT 片段',
    'PRINTD 片段',
    'PRINTFORML',
    'PRINTFORMW',
    'PRINTFORMDW',
    'PRINTFORMDL',
    'PRINTL',
    'PRINTBUTTON "x", 1',
    `PRINTFORMW 她${B}CFLAG:2 >= 50?甲#乙${B}看着你。`,
    `PRINTFORMW 她${B} A ? x ${B}看着你。`,
    'SIF CFLAG:2 >= 50\n\tPRINTFORMDW 甲。',
    'SIF CFLAG:2 >= 50\nPRINTFORMDW 甲。',
    'IF CFLAG:2 >= 50\n\tPRINTFORMDW 甲。\nENDIF',
    'SELECTCASE TFLAG:193\n\tCASE 1\n\t\tPRINTFORMDW 甲。\nENDSELECT',
    'PRINTFORMW %CALLNAME:TARGET%来了。',
    '; 注释行',
    '',
    'CALL HOGEGE',
  ];

  it('被投影成糖的每一行，建议侧都答过（出候选 or 记跳过）', () => {
    let displayed = 0;
    let withCandidate = 0;
    for (const src of probes) {
      const r = lift(src);
      const { segments } = liftProject(projDeps(), { source: src });
      for (const seg of segments) {
        for (let line = seg.fromLine; line <= seg.toLine; line++) {
          // 收束行（ENDIF 等）不产出可见行，但仍是"被糖覆盖"→ 建议侧同样必须答过
          displayed++;
          if (
            r.candidates.some((c) => line >= c.fromLine && line <= c.toLine) ||
            r.skipped.some((s) => line >= s.fromLine && line <= s.toLine)
          ) {
            if (r.candidates.some((c) => line >= c.fromLine && line <= c.toLine)) withCandidate++;
            continue;
          }
          throw new Error(`静默：形态显示成糖却没被建议侧回答 → ${JSON.stringify(src)} 第 ${line} 行`);
        }
      }
    }
    // 尺子：不许是"因为什么都没显示"而空过
    expect(displayed).toBeGreaterThan(20);
    expect(withCandidate).toBeGreaterThan(10);
  });

  it('反向：建议侧出了候选的形态，显示侧不可能留原码（同一张表的 writable ⇒ displayable）', () => {
    for (const src of probes) {
      const r = lift(src);
      if (r.candidates.length === 0) continue;
      const { segments } = liftProject(projDeps(), { source: src });
      for (const c of r.candidates) {
        // 块级候选的收束行不产出可见文本，故只问"这个区间是否落进了某个段"
        expect(
          segments.some((s) => s.fromLine <= c.toLine && s.toLine >= c.fromLine),
          `候选区间没被投影覆盖：${JSON.stringify(src)} 第 ${c.fromLine}–${c.toLine} 行`,
        ).toBe(true);
      }
    }
  });

  it('投影侧一次都不调用转译（用途差异不越界：显示不承诺可写回）', () => {
    for (const src of probes) {
      expect(() => liftProject(projDeps(), { source: src })).not.toThrow();
    }
  });
});

/* ============================== 四、文件结构行：只显不写 ============================== */

describe('W5 / 函数头（时机名反解）—— 显示侧标、建议侧不产候选', () => {
  /** 带时机分野表的投影依赖（表缺席 = 一个头都不标——与 codegen.resolveFace 的 fail-closed 同纪律） */
  const faceDeps = (): LiftDeps => ({
    transpile: () => {
      throw new Error('投影不该调用 transpile');
    },
    scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
    faceTable: () => stubFaceTable(),
  });

  it('显示侧认得这个头（标成「时机 …：」），建议侧恒不出候选', () => {
    const src = ['@M_KOJO_MESSAGE_COM_K1_310', 'PRINTFORMW 「甲」'].join(String.fromCharCode(10));
    const { segments } = liftProject(faceDeps(), { source: src });
    expect(segments[0]!.sugarText.split(String.fromCharCode(10))[0]).toBe('时机 指令 310：');
    const r = lift(src);
    expect(r.candidates.filter((c) => c.fromLine === 1)).toHaveLength(0);
    expect(FACE_HEAD_WRITABLE).toBe(false);
  });
  it('块区间撞上函数头时，建议侧给"预处理 / 函数声明"的明确理由（不静默）', () => {
    const src = ['IF CFLAG:2 >= 50', '\tPRINTFORMDW 甲。', '@M_KOJO_K1_指令_2', 'ENDIF'].join('\n');
    const r = lift(src);
    expect(r.skipped.map((x) => x.reason)).toContain('macro-or-directive');
  });
});
