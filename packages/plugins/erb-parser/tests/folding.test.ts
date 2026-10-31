/**
 * ERB 折叠区间（D3）单测。
 *
 * 走**真扫描器**（`scanControlFlow` + `parseErbText`）而不是手搓 `ControlFlowStatement`：
 * 折叠的全部价值建立在"区间端点与源行对得上、配对表与骨架/体检同一张"上，手搓语句表
 * 只能证明栈算法自洽。栈算法本体仍单测（喂合成语句表），因为容错分支很难用真文本凑齐。
 *
 * 覆盖：正常配对 / 分支段（CASE、ELSE）/ TRY 系与 CATCH 归属 / PRINTDATA 系；
 * 结构错误文件的边界口径（未闭合不吞全篇、函数边界重置、孤儿闭合无主分支不动栈）；
 * 空文件；超长文件的量级读数（区间数 + 耗时上限，防"provider 里做全文正则二次扫描"回潮）。
 *
 * `preprocFoldingRanges`（K7，2026-10-25 体感批 v2）另钉五件事：区间形状与语言包侧
 * `erb-syntax-tree/src/index.ts` 的 `collectPreprocFolds` **逐条同形**（夹具直接抄 K3 在
 * `packages/erb-syntax-tree/tests/parse-structure.test.ts` 里那四组样本，行号换成 1 基）；
 * 与 `checkPreprocStructure` 同口径（SKIP 死区 / `;!;`+`;#;` 前缀 / 未配对不产，屏蔽语义取自
 * `scanner.ts` 的共用门 `forEachControlFlowLine`，不自己写第二套）；
 * **不按 `@` 函数行清栈**（控制流那一侧要清，这一侧不能清）；
 * 角色判据的**字形镜像**逐字节钉回契约真源（`PITFALLS.md` §151：本文件被
 * `fold-compare.mjs` 用裸 node 直读，值导入 `@kojo/plugin-api` 会撞上 `io.ts` 的参数属性）。
 * 分支段在真语料上不产（基线盘 `[ELSE]` 0 枚：`[IF…]` 84 开 / 84 收），所以形状只能靠夹具钉——
 * 跨壳的同形闸由 `node packages/erb-syntax-tree/tools/fold-compare.mjs --gate` 的
 * "服务侧未包含 0"兜底（真语料 3,971 份逐区间对拍）。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement } from '@kojo/plugin-api';
import { ERB_CONTINUATION_MARKERS, ERB_PREPROC_PATTERNS, ERB_SKIP_MARKERS, erbPreprocRoleOf } from '@kojo/plugin-api';
import {
  FOLD_CONTINUATION_MARKERS,
  FOLD_PREPROC_PATTERNS,
  FOLD_SKIP_MARKERS,
  continuationFoldingRanges,
  controlFlowFoldingRanges,
  erbFoldingRanges,
  foldPreprocRoleOf,
  functionFoldingRanges,
  preprocFoldingRanges,
  skipBlockFoldingRanges,
} from '../src/folding';
import { parseErbText, scanControlFlow } from '../src/scanner';
import { checkPreprocStructure, preprocRoleOf } from '../src/structure';

const has = (ranges: readonly { startLine: number; endLine: number }[], start: number, end: number): boolean =>
  ranges.some((r) => r.startLine === start && r.endLine === end);

describe('controlFlowFoldingRanges · 正常配对', () => {
  it('WHILE…WEND（无分支块）：只给整块区间，不给只差闭合行的重复段', () => {
    const text = ['@F', 'WHILE A < 3', 'PRINTL 一', 'WEND', 'RETURN'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(ranges).toEqual([{ startLine: 2, endLine: 4 }]);
  });

  it('IF…ELSE…ENDIF：整块 + 每个分支段各一枚', () => {
    const text = [
      'IF A == 1', // 1
      'PRINTL 甲', // 2
      'PRINTL 乙', // 3
      'ELSE', // 4
      'PRINTL 丙', // 5
      'ENDIF', // 6
    ].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 6)).toBe(true); // 整块
    expect(has(ranges, 1, 3)).toBe(true); // IF 段
    expect(has(ranges, 4, 5)).toBe(true); // ELSE 段
  });

  it('SELECTCASE 多分支：每段折到下一分支前一行，段体单行不出段（无可隐藏行）', () => {
    const text = [
      'SELECTCASE RAND:2', // 1
      'CASE 1', // 2
      'PRINTL 一', // 3
      'CASE 2', // 4
      'PRINTL 二', // 5
      'ENDSELECT', // 6
    ].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 6)).toBe(true);
    expect(has(ranges, 2, 3)).toBe(true);
    expect(has(ranges, 4, 5)).toBe(true);
    expect(ranges.some((r) => r.startLine === 1 && r.endLine === 1)).toBe(false);
  });

  it('嵌套块各自成区间（深度由配对表重建，不靠缩进）', () => {
    const text = ['IF A', 'IF B', 'PRINTL 深', 'ENDIF', 'ENDIF'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 5)).toBe(true);
    expect(has(ranges, 2, 4)).toBe(true);
  });

  it('PRINTDATA…ENDDATA 与 DATALIST…ENDLIST 正常闭合', () => {
    const text = ['PRINTDATA', 'PRINTL 甲', 'ENDDATA', 'DATALIST', 'ITEM 1 2', 'ENDLIST'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 3)).toBe(true);
    expect(has(ranges, 4, 6)).toBe(true);
  });

  it('TRYCALLLIST…CATCH…ENDFUNC：CATCH 归 funclist 层（同体检判据），整块与 CATCH 段都给', () => {
    const text = ['TRYCALLLIST', 'CALL A', 'CALL B', 'CATCH', 'CALL C', 'ENDFUNC'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 6)).toBe(true);
    expect(has(ranges, 4, 5)).toBe(true);
  });

  it('TRYCGOTO…CATCH…ENDCATCH：try 层的 CATCH 走正常配对', () => {
    const text = ['TRYCGOTO *先, LABEL:目标', 'CATCH', 'PRINTL 失败', 'ENDCATCH'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text));
    expect(has(ranges, 1, 4)).toBe(true);
    expect(has(ranges, 2, 3)).toBe(true);
  });
});

describe('controlFlowFoldingRanges · 结构错误边界', () => {
  const st = (kind: string, line: number): ControlFlowStatement => ({ kind, expression: '', depth: 0, line });

  it('未闭合的开块不产出区间，且**不吞**别的正常块（文件尾 / 中段都算）', () => {
    const ranges = controlFlowFoldingRanges([st('IF', 1), st('PRINTDATA', 2), st('ENDDATA', 3)]);
    expect(ranges).toEqual([{ startLine: 2, endLine: 3 }]); // 欠 ENDIF 的 IF 不发 [1..?]
  });

  it('孤儿闭合不关别人的门（裸 ENDSELECT 不许把 IF 提前收尾）', () => {
    const orphan = controlFlowFoldingRanges([st('IF', 1), st('ENDSELECT', 2), st('ENDIF', 3)]);
    expect(orphan).toEqual([{ startLine: 1, endLine: 3 }]); // ENDSELECT 不动栈，ENDIF 照常关 IF
  });

  it('错配嵌套（IF→REPEAT→ENDIF）：REPEAT 残缺不发区间，IF 照常整块', () => {
    const ranges = controlFlowFoldingRanges([st('IF', 1), st('REPEAT', 2), st('ENDIF', 3)]);
    expect(ranges).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('函数边界清空栈：上一函数欠的 ENDIF 不许把下一函数整段折走', () => {
    const text = ['@F1', 'IF A', '@F2', 'PRINTL 乙', 'ENDIF'].join('\n');
    const ranges = controlFlowFoldingRanges(scanControlFlow(text), [1, 3]);
    expect(ranges).toEqual([]); // IF 未闭合于 F1：不产出；F2 的 ENDIF 成了孤儿也不产出
  });

  it('分支无主（裸 ELSE）不动栈', () => {
    const ranges = controlFlowFoldingRanges([st('ELSE', 1), st('IF', 2), st('ENDIF', 3)]);
    expect(ranges).toEqual([{ startLine: 2, endLine: 3 }]);
  });

  it('SIF 单行语句不开块', () => {
    const ranges = controlFlowFoldingRanges([st('SIF', 1), st('IF', 2), st('ENDIF', 3)]);
    expect(ranges).toEqual([{ startLine: 2, endLine: 3 }]);
  });
});

describe('erbFoldingRanges · 文本级', () => {
  it('函数区间逐 `@` 块给出（与大纲同源的边界）', () => {
    const text = ['@F1', 'PRINTL 一', '@F2', 'PRINTL 二'].join('\n');
    const file = parseErbText(text);
    expect(functionFoldingRanges(file)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
    ]);
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 1, 2)).toBe(true);
    expect(has(ranges, 3, 4)).toBe(true);
  });

  it('空文件 → 空区间（认这个文件但无可折块）', () => {
    expect(erbFoldingRanges('')).toEqual([]);
  });

  it('正常小样本：函数块 + 内部控制流同时在场、行号各就各位', () => {
    const text = [
      '@M_KOJO_TEST', // 1
      'SELECTCASE RAND:2', // 2
      'CASE 1', // 3
      'PRINTL 甲', // 4
      'CASE 2', // 5
      'PRINTL 乙', // 6
      'ENDSELECT', // 7
      'RETURN', // 8
    ].join('\n');
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 1, 8)).toBe(true);
    expect(has(ranges, 2, 7)).toBe(true);
    expect(has(ranges, 3, 4)).toBe(true);
    expect(has(ranges, 5, 6)).toBe(true);
    for (const r of ranges) expect(r.endLine).toBeGreaterThan(r.startLine);
  });

  it('超长文件（52,601 行语料同量级合成）：区间数与耗时有上限读数，provider 不许退化成全文正则再扫', () => {
    const unit = ['@F_K0', 'IF A == 1', 'ELSEIF A == 2', 'ELSE', 'PRINTL 甲', 'ENDIF', 'RETURN'];
    const parts: string[] = [];
    const perFunction = unit.length; // 7 行/函数
    const count = Math.ceil((52_601 - 1) / perFunction);
    for (let i = 0; i < count; i++) parts.push(unit.map((line) => (line === '@F_K0' ? `@F_${i}` : line)).join('\n'));
    const text = parts.join('\n');
    expect(text.split('\n').length).toBeGreaterThan(50_000);
    const t0 = performance.now();
    const ranges = erbFoldingRanges(text);
    const elapsed = performance.now() - t0;
    // 每函数至少 2 枚区间（函数块 + IF 整块），再加两条 ELSEIF/ELSE 段
    expect(ranges.length).toBeGreaterThanOrEqual(count * 2);
    // 读数上限放得极宽（防数量级回归用，不是微基准）：CI 抖动不至于踩到
    expect(elapsed).toBeLessThan(4_000);
  });
});

/* ===================== 预处理条件块（K7：折叠真的上屏） ===================== */

/** 夹具行号即 1 基（`preprocFoldingRanges` 与真壳 provider 用的都是 1 基行） */
const doc = (...rows: string[]): string => rows.join('\n');

/**
 * 角色对拍样本表：与 `tests/preproc-block.test.ts` 的 `ROLE_SAMPLES`、
 * `packages/app/tests/erb-preproc-single-source.test.ts` 的 `RECOGNIZED` / `NOT_RECOGNIZED`
 * 同一批形态（含语料实测的大小写与空格变体、ASCII 画的方括号行、残形）。
 */
const PREPROC_ROLE_SAMPLES = [
  '[IF XXX]', '[IF 口上]', '[IF_DEBUG]', '[IF_NDEBUG]', '[if xxx]', '[If_Debug]',
  '[ELSEIF XXX]', '[ELSE]', '[else]', '[ENDIF]', '[endif]',
  '[IF]', '[ENDIF] 尾巴', '[SKIPSTART]', '[SKIPEND]', '[RANDOMIZE]', '[[跳蛋]]', '[IF_DEBUG] 注',
  'IF X', 'ENDIF', '', '[IF_DEBUGX]', '[IF_DEBUG X]',
  '[ IF XXX]', '[ENDIF]\t', '[ELSEIF ]', '[elseif a]', '[ 1 2 3 ]', '[MACRO]', '[IF ]',
];

describe('preprocFoldingRanges · 判据镜像钉回契约真源（PITFALLS §151 的第二份字形不许漂）', () => {
  it('三枚 pattern 的 `source` 与 `flags` 逐字等于契约层（不是"行为相似"）', () => {
    for (const role of ['open', 'branch', 'close'] as const) {
      expect(FOLD_PREPROC_PATTERNS[role].source, `折叠侧 ${role} 的 pattern 源偏离真源`).toBe(
        ERB_PREPROC_PATTERNS[role].source,
      );
      expect(FOLD_PREPROC_PATTERNS[role].flags, `折叠侧 ${role} 的标志偏离真源`).toBe(
        ERB_PREPROC_PATTERNS[role].flags,
      );
      expect(/[gy]/.test(FOLD_PREPROC_PATTERNS[role].flags), '共享实例必须无状态').toBe(false);
    }
  });

  it('逐样本角色对拍：折叠侧 == 契约真源 == 波浪线侧委托面（三处任一偏离即红）', () => {
    for (const s of PREPROC_ROLE_SAMPLES) {
      const truth = erbPreprocRoleOf(s);
      expect(foldPreprocRoleOf(s), `折叠侧偏离真源：${JSON.stringify(s)}`).toBe(truth);
      expect(preprocRoleOf(s), `波浪线侧偏离真源：${JSON.stringify(s)}`).toBe(truth);
    }
    // 样本表本身不是全零（防"三枚正则一起写坏 + 三条委托一起跟随"的假绿）
    expect(new Set(PREPROC_ROLE_SAMPLES.map((s) => erbPreprocRoleOf(s)))).toEqual(
      new Set(['open', 'branch', 'close', null]),
    );
  });

  it('停用区两枚标记由 scanner 的共用门给出（本文件不写第三种等值判据）：`[SKIPSTART]` 起的死区不产区间', () => {
    // 契约层的两枚字符串仍是真源（scanner.ts 内的等值字面量被构建期投影抽取，不许常量化）
    expect(ERB_SKIP_MARKERS).toEqual({ start: '[SKIPSTART]', end: '[SKIPEND]' });
    expect(preprocFoldingRanges(doc(ERB_SKIP_MARKERS.start, '[IF a]', '[ENDIF]', ERB_SKIP_MARKERS.end))).toEqual([]);
  });

  it('分叉探测器：体检报"未闭合"的开块行绝不产区间，配平的块一律产', () => {
    const texts = [
      doc('[IF a]', 'PRINTL 甲', '[ENDIF]'),
      doc('[IF a]', 'PRINTL 甲'), // 少一枚 [ENDIF]
      doc('[IF a]', '[IF b]', 'PRINTL 甲', '[ENDIF]'), // 外层没等到收束
      doc('[ELSE]', '[IF a]', 'PRINTL 甲', '[ENDIF]'), // 无主分支在前
      doc('[SKIPSTART]', '[IF a]', '[ENDIF]', '[ENDIF]', '[SKIPEND]'), // 死区里多一枚
      doc(';!;[IF a]', 'PRINTL 甲', ';#;[ENDIF]'), // 代码前缀形态
      doc('@F1', '[IF a]', 'PRINTL 甲', '@F2', 'PRINTL 乙', '[ENDIF]'), // 跨函数
    ];
    for (const text of texts) {
      const unclosed = new Set(
        checkPreprocStructure(text)
          .filter((i) => i.kind === 'unclosed-open')
          .map((i) => i.line),
      );
      const starts = new Set(preprocFoldingRanges(text).map((r) => r.startLine));
      for (const line of unclosed) expect(starts.has(line), `未闭合的第 ${line} 行折了`).toBe(false);
      // 每个区间都真能藏行（零跨度一律不产）
      for (const r of preprocFoldingRanges(text)) expect(r.endLine).toBeGreaterThan(r.startLine);
    }
  });
});

describe('preprocFoldingRanges · 区间形状与语言包侧 collectPreprocFolds 逐条同形', () => {
  it('无分支块：只给整块区间，不补只差收束行的重复段', () => {
    const text = doc('@F', '[IF_DEBUG]', 'PRINTL 甲', '[ENDIF]', 'RETURN');
    expect(preprocFoldingRanges(text)).toEqual([{ startLine: 2, endLine: 4 }]);
  });

  it('[ELSE] 块：块头段 + 末段 + 整块（同 parse-structure.test.ts 的第二条样本）', () => {
    const text = doc('[IF AAA]', 'PRINTL A', 'PRINTL B', '[ELSE]', 'PRINTL C', '[ENDIF]');
    expect(preprocFoldingRanges(text)).toEqual([
      { startLine: 1, endLine: 3 }, // 块头段：开块行 → 分支前一行
      { startLine: 4, endLine: 5 }, // 末段：分支行 → 收束前一行
      { startLine: 1, endLine: 6 }, // 整块
    ]);
  });

  it('[ELSEIF] 多分支：段止于下一分支前一行；零跨度块头段不产（同 P0-3/K3 夹具）', () => {
    const text = doc(
      '@F', // 1
      '[IF_DEBUG]', // 2
      'PRINTL 甲', // 3
      '[ENDIF]', // 4
      '[IF XXX]', // 5
      '[ELSEIF YYY]', // 6
      'PRINTL B', // 7
      '[ELSE]', // 8
      'PRINTL C', // 9
      '[ENDIF]', // 10
    );
    const ranges = preprocFoldingRanges(text);
    expect(has(ranges, 2, 4)).toBe(true); // 无分支块：只有整块
    expect(has(ranges, 6, 7)).toBe(true); // ELSEIF 体
    expect(has(ranges, 8, 9)).toBe(true); // ELSE 体
    expect(has(ranges, 5, 10)).toBe(true); // 外层整块
    expect(has(ranges, 5, 5)).toBe(false); // `[IF XXX]` 紧邻 `[ELSEIF]` ⇒ 零跨度不产
    expect(ranges.every((r) => r.endLine > r.startLine)).toBe(true);
    expect(ranges).toHaveLength(4);
  });

  it('嵌套：内层三段齐出，外层块头段把内层整块包住（与文法侧同形状）', () => {
    const text = doc(
      '[IF AAA]', // 1
      'PRINTL A', // 2
      '[IF BBB]', // 3
      'PRINTL B', // 4
      '[ELSE]', // 5
      'PRINTL C', // 6
      '[ENDIF]', // 7
      '[ELSE]', // 8
      'PRINTL D', // 9
      '[ENDIF]', // 10
    );
    expect(preprocFoldingRanges(text)).toEqual([
      { startLine: 3, endLine: 4 }, // 内层块头段
      { startLine: 5, endLine: 6 }, // 内层末段
      { startLine: 3, endLine: 7 }, // 内层整块
      { startLine: 1, endLine: 7 }, // 外层块头段（含内层整块）
      { startLine: 8, endLine: 9 }, // 外层末段
      { startLine: 1, endLine: 10 }, // 外层整块
    ]);
  });

  it('三个开块形共用一枚 `[ENDIF]`：`[IF_DEBUG]` / `[IF_NDEBUG]` / `[IF 宏名]` 都算开块', () => {
    for (const open of ['[IF_DEBUG]', '[IF_NDEBUG]', '[IF XXX]', '[if xxx]', '[If_Debug]']) {
      expect(preprocFoldingRanges(doc(open, 'PRINTL 甲', '[ENDIF]')), open).toEqual([
        { startLine: 1, endLine: 3 },
      ]);
    }
  });
});

describe('preprocFoldingRanges · 与 checkPreprocStructure 同口径（死区 / 前缀 / 未配对）', () => {
  it('[SKIPSTART]…[SKIPEND] 死区里的标记不算标记（引擎根本不编译那段）', () => {
    const text = doc('[SKIPSTART]', '[IF_DEBUG]', '[ENDIF]', '[ENDIF]', '[SKIPEND]', '[IF x]', 'PRINTL 甲', '[ENDIF]');
    // 死区里那对 `[IF_DEBUG]`/`[ENDIF]` 不产，且第 4 行多出来的 `[ENDIF]` 也不许把区外的块提前关掉
    expect(preprocFoldingRanges(text)).toEqual([{ startLine: 6, endLine: 8 }]);
    expect(checkPreprocStructure(text)).toEqual([]); // 同一口径：体检也认为这篇没毛病
  });

  it('行首代码前缀 `;!;` / `;#;` 由共用门剥掉（门内即 `erbCodeBodyOf`），剥完照认照折', () => {
    const text = doc(';!;[IF DEBUG]', 'PRINTL 甲', ';#;[ELSE]', 'PRINTL 乙', ';!;[ENDIF]');
    expect(preprocFoldingRanges(text)).toEqual([
      { startLine: 1, endLine: 2 },
      { startLine: 3, endLine: 4 },
      { startLine: 1, endLine: 5 },
    ]);
  });

  it('未配对一律不产：未闭合块 / 孤儿 `[ENDIF]` / 无主 `[ELSE]`（宁少不错）', () => {
    const text = doc(
      '[ELSE]', // 1 无主分支：栈空 ⇒ 不动、不产
      '[IF AAA]', // 2
      'PRINTL A', // 3
      '[ELSE]', // 4 产块头段 2..3；随后 4..4 的末段零跨度 ⇒ 不产
      '[ENDIF]', // 5
      '[ENDIF]', // 6 孤儿收束：栈已空 ⇒ 不产
      '[IF BBB]', // 7 到文件尾仍未闭合 ⇒ 不产（不许折到文末吞掉全篇）
      'PRINTL B', // 8
    );
    expect(preprocFoldingRanges(text)).toEqual([
      { startLine: 2, endLine: 3 },
      { startLine: 2, endLine: 5 },
    ]);
    expect(preprocFoldingRanges('[IF DEBUG]')).toEqual([]); // 只有开块
    expect(preprocFoldingRanges('[ENDIF]')).toEqual([]); // 只有收束
  });

  it('不是标记的方括号行一律不认（`[IF]` 裸形 / 带尾巴 / ASCII 画）', () => {
    expect(preprocFoldingRanges(doc('[IF]', 'PRINTL 甲', '[ENDIF] 尾巴', '[ 1 2 3 ]', '[[跳蛋]]'))).toEqual([]);
  });

  it('预处理块横跨 `@` 函数定义**照常折**：引擎是文件级裁剪，不清栈（与控制流那一侧相反）', () => {
    const text = doc('@F1', '[IF DEBUG]', 'PRINTL 甲', '@F2', 'PRINTL 乙', '[ENDIF]');
    expect(preprocFoldingRanges(text)).toEqual([{ startLine: 2, endLine: 6 }]);
    // 反面对照：控制流那一侧同样跨函数就是残缺 ⇒ 函数边界清空语义只在它那边生效
    expect(controlFlowFoldingRanges(scanControlFlow(text), [1, 4])).toEqual([]);
  });

  it('不变式：同一份文本，体检说"配平"的块必产整块，体检报缺陷的块必不产（两条判据不许分叉）', () => {
    const balanced = doc('[IF A]', 'PRINTL 甲', '[ELSE]', 'PRINTL 乙', '[ENDIF]', '[IF_DEBUG]', 'PRINTL 丙', '[ENDIF]');
    expect(checkPreprocStructure(balanced)).toEqual([]);
    expect(preprocFoldingRanges(balanced).filter((r) => r.endLine - r.startLine > 0)).toHaveLength(4);
    const broken = doc('[IF A]', 'PRINTL 甲', '[ENDIF]', '[ENDIF]');
    expect(checkPreprocStructure(broken).map((i) => i.kind)).toEqual(['orphan-close']);
    expect(preprocFoldingRanges(broken)).toEqual([{ startLine: 1, endLine: 3 }]); // 缺陷那条不产区间
  });
});

describe('erbFoldingRanges · 预处理区间接进真壳消费的那条路', () => {
  it('函数块 + 控制流块 + 预处理块三族同时在场，行号各就各位', () => {
    const text = doc(
      '@M_KOJO_TEST', // 1
      '[IF_DEBUG]', // 2
      'IF A == 1', // 3
      'PRINTL 甲', // 4
      '[ENDIF]', // 5
      'ENDIF', // 6
      'RETURN', // 7
    );
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 2, 5)).toBe(true); // 预处理整块（本卡新增）
    expect(has(ranges, 3, 6)).toBe(true); // 控制流整块（`ENDIF` 归它自己那张栈）
    expect(ranges.some((r) => r.startLine === 1)).toBe(true); // 函数块
    for (const r of ranges) expect(r.endLine).toBeGreaterThan(r.startLine);
  });

  it('两族互不污染：`[IF_DEBUG]` 里开控制流 `IF`、`[ENDIF]` 之后才 `ENDIF`（合法写法）两边都照折', () => {
    const text = doc('@F', '[IF_DEBUG]', 'IF FLAG:1', 'PRINTL 甲', '[ENDIF]', 'ENDIF', 'RETURN');
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 2, 5)).toBe(true); // 预处理块
    expect(has(ranges, 3, 6)).toBe(true); // 控制流块
    expect(checkPreprocStructure(text)).toEqual([]);
  });

  it('超长文件 + 预处理块同场：K7 新增的那一遍仍是 O(行数)（与上面 4,000 ms 上限同档）', () => {
    const unit = [
      '@F_P0', // 1
      '[IF DEBUG]', // 2
      'IF A == 1', // 3
      'PRINTL 甲', // 4
      '[ELSE]', // 5
      'PRINTL 乙', // 6
      '[ENDIF]', // 7
      'ENDIF', // 8
      'RETURN', // 9
    ];
    const perFunction = unit.length;
    const count = Math.ceil((52_601 - 1) / perFunction);
    const text = Array.from({ length: count }, (_, i) =>
      unit.map((line) => (line === '@F_P0' ? `@F_${i}` : line)).join('\n'),
    ).join('\n');
    expect(text.split('\n').length).toBeGreaterThan(50_000);
    const t0 = performance.now();
    const ranges = erbFoldingRanges(text);
    const elapsed = performance.now() - t0;
    // 每函数 5 枚（函数块 + IF 整块 + 预处理块头段/末段/整块）；留一档余量给收尾函数
    expect(ranges.length).toBeGreaterThanOrEqual(count * 5 - 5);
    // 第一组单位的逐条形状（行号绝对，防"整体位移"这类错）
    expect(has(ranges, 2, 4)).toBe(true);
    expect(has(ranges, 5, 6)).toBe(true);
    expect(has(ranges, 2, 7)).toBe(true);
    expect(has(ranges, 3, 8)).toBe(true);
    expect(has(ranges, 1, 9)).toBe(true);
    expect(elapsed).toBeLessThan(4_000);
  });
});

/* ==================== 停用区折叠（R5，2026-10-29 折叠单源） ==================== */

describe('skipBlockFoldingRanges · 停用区（[SKIPSTART]…[SKIPEND]）', () => {
  it('标记串是契约真源的字形镜像（不是"看着像"）', () => {
    expect(FOLD_SKIP_MARKERS.start, '折叠侧 start 偏离真源').toBe(ERB_SKIP_MARKERS.start);
    expect(FOLD_SKIP_MARKERS.end, '折叠侧 end 偏离真源').toBe(ERB_SKIP_MARKERS.end);
  });

  it('配对的一区 ⇒ 一条区间（1 基闭区间，块内行数 > 0 才产）', () => {
    const text = ['@F', 'IF A', '[SKIPSTART]', 'IF 死代码', 'ENDIF', '[SKIPEND]', 'ENDIF'].join('\n');
    expect(skipBlockFoldingRanges(text)).toEqual([{ startLine: 3, endLine: 6 }]);
  });

  it('区内嵌套的 [SKIPSTART] 不叠层（与 parseErbText 同判：只认 [SKIPEND]）', () => {
    const text = ['[SKIPSTART]', '[SKIPSTART]', 'x', '[SKIPEND]', 'y'].join('\n');
    expect(skipBlockFoldingRanges(text)).toEqual([{ startLine: 1, endLine: 4 }]);
  });

  it('裸 [SKIPEND] 不动任何东西；未闭合的区不产区间（不许吞到文末）', () => {
    expect(skipBlockFoldingRanges(['a', '[SKIPEND]', 'b'].join('\n'))).toEqual([]);
    expect(skipBlockFoldingRanges(['a', '[SKIPSTART]', 'b', 'c'].join('\n'))).toEqual([]);
  });

  it('代码前缀 `;!;` 真的开区 / 收区（与 scanner 的屏蔽状态机同源）', () => {
    const text = [';!;[SKIPSTART]', '死代码', ';!;[SKIPEND]'].join('\n');
    expect(skipBlockFoldingRanges(text)).toEqual([{ startLine: 1, endLine: 3 }]);
  });

  it('CRLF 与首尾空白不影响判据（行切分与 scanner 的 normalizeEol 同一条）', () => {
    const text = 'a\r\n  [SKIPSTART]  \r\nb\r\n\t[SKIPEND]\r\nc';
    expect(skipBlockFoldingRanges(text)).toEqual([{ startLine: 2, endLine: 4 }]);
  });

  it('端到端：停用区里的 IF/ENDIF 不进控制流栈，但停用区自身可折', () => {
    const text = ['@F', 'IF A == 1', '[SKIPSTART]', 'IF B == 2', 'ENDIF', '[SKIPEND]', 'ENDIF'].join('\n');
    const ranges = erbFoldingRanges(text);
    // 停用区那一条在
    expect(has(ranges, 3, 6)).toBe(true);
    // 外面的 IF A 折到 ENDIF（第 7 行）——若停用区里的 ENDIF 进了栈，这条会被拆成两截
    expect(has(ranges, 2, 7)).toBe(true);
    // 区内那条 IF B 不该有自己的区间（引擎根本不编译那一段）
    expect(has(ranges, 4, 5)).toBe(false);
  });
});

/* ==================== 行连接块折叠（R5，2026-10-29 折叠单源） ==================== */

describe('continuationFoldingRanges · 行连接（`{` … `}`）', () => {
  it('标记串是契约真源的字形镜像', () => {
    expect(FOLD_CONTINUATION_MARKERS.open, '折叠侧 open 偏离真源').toBe(ERB_CONTINUATION_MARKERS.open);
    expect(FOLD_CONTINUATION_MARKERS.close, '折叠侧 close 偏离真源').toBe(ERB_CONTINUATION_MARKERS.close);
  });

  it('配对 ⇒ 一条区间；收束行**允许缩进**（契约判据是 trim 等值，不是列 0）', () => {
    const text = ['IF GROUPMATCH(A,', '{', '  [[甲]], [[乙]],', ' [[丙]])', ' }', 'PRINTL x', 'ENDIF'].join('\n');
    expect(continuationFoldingRanges(text)).toEqual([{ startLine: 2, endLine: 5 }]);
  });

  it('未闭合 / 行内花括号 / `;!;{` 一律不产（契约层那三条语言事实）', () => {
    expect(continuationFoldingRanges(['{', 'A', 'B'].join('\n'))).toEqual([]);
    expect(continuationFoldingRanges(['IF A && { 1, 2 }', 'PRINTL x'].join('\n'))).toEqual([]);
    expect(continuationFoldingRanges([';!;{', 'A', '}'].join('\n'))).toEqual([]);
  });

  it('多块各归各的；中间的普通行不受影响', () => {
    const text = ['{', 'A', '}', 'PRINTL x', '{', 'B', '}'].join('\n');
    expect(continuationFoldingRanges(text)).toEqual([
      { startLine: 1, endLine: 3 },
      { startLine: 5, endLine: 7 },
    ]);
  });

  it('端到端：块内那三层 IF 各自成折，行连接块只包住它自己（不许吞到下一个结构行）', () => {
    const text = ['@F', '{', 'IF A', 'PRINTL x', 'ENDIF', '}', 'IF B', 'PRINTL y', 'ENDIF'].join('\n');
    const ranges = erbFoldingRanges(text);
    expect(has(ranges, 2, 6)).toBe(true); // 行连接块
    expect(has(ranges, 3, 5)).toBe(true); // 块内的 IF
    expect(has(ranges, 7, 9)).toBe(true); // 块外的 IF 不受影响
  });
});
