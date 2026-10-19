/**
 * **ZH-P 线验收 · 投影集成 + RETURN 行归零**（kojo 全中文化系列，2026-10-17）。
 *
 * 本文件只测两件事，且两条都是**本文件红线**（口径住 `../src/native-display/types.ts`）：
 *
 * 1. **native 行的本地化接线**：project.ts 里每一个 `native()` 落点都过 `localizeNativeLine`
 *    ——pass 命中 → 中文显示形；全 pass 认不出 → 显式兜底 `未识别语句 · <原文>`，且**必须成段**
 *    （nativeOnly 段）才到得了屏幕。（合流注：ZH-S / ZH-C 两线的 pass 已在 master 全量，`CALL` /
 *    `SETCOLOR` 等常见行命中中文形；本文件钉「认不出」用两条 pass 结构上就生拒的标杆——`@` 函数头。
 *    判据不为合流打折：命中文形与兜底形**同样**不得与源行逐字相等。）
 * 2. **函数骨架 `RETURN` 永不上屏**：函数体内单独成行的 `RETURN …` 一律吸收（只读视图
 *    不显示，磁盘一字不动）；`RETURNF <值>` 显示 `返回 <值>`；MESSAGECHECK 数字返回
 *    （`隐藏情景（数字返回 1）：`）信息量更大 → **先于**骨架判定、不被吃。
 *
 * 尺子只有一把：`countVerbatimNativeLines`（红线 = 0）。负自证把一行改回原文，
 * 证明读数真的在数、不是恒 0。
 */

import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarProjectSegment } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { stubFaceTable } from './support';
import { countVerbatimNativeLines, isVerbatimNativeLine } from '../src/native-display/types';

/** 投影只依赖结构扫描；`transpile` 不参与（用抛错替身证明"确实没被调用"） */
const deps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (text: string): ControlFlowStatement[] => scanControlFlow(text),
});

const withFaces = (source: string): ReturnType<typeof liftProject> =>
  liftProject({ ...deps(), faceTable: () => stubFaceTable() }, { source });

const project = (source: string): ReturnType<typeof liftProject> => liftProject(deps(), { source });

const split = (source: string): string[] => source.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

/** 真糖段（nativeOnly 段是"工具没读懂"的兜底段） */
const sugarSegs = (segments: SugarProjectSegment[]): SugarProjectSegment[] =>
  segments.filter((s) => s.nativeOnly !== true);
/** 兜底段 */
const nativeSegs = (segments: SugarProjectSegment[]): SugarProjectSegment[] =>
  segments.filter((s) => s.nativeOnly === true);

/**
 * 宿主式逐行拼接（`composeSugarDoc` 同口径）：段区间内用 `sugarText`，段外回显原文。
 *
 * 供红线尺子按**对位**比较。注意：E13-1② 的家族头一行会变两行，那类源不进本行数对账；
 * 本文件的语料刻意避开它。
 */
function composeLikeHost(source: string, segments: ReadonlyArray<SugarProjectSegment>): string[] {
  const src = split(source);
  const out: string[] = [];
  let cur = 0; // 0 基
  for (const s of segments) {
    for (; cur < s.fromLine - 1; cur++) out.push(src[cur] ?? '');
    for (const l of s.sugarText.split('\n')) out.push(l);
    cur = s.toLine;
  }
  for (; cur < src.length; cur++) out.push(src[cur] ?? '');
  return out;
}

/* ============================================================================
 * 一、native 行兜底：nativeOnly 段的出现与形状
 * ========================================================================== */

describe('native 兜底段 · 出现与拼接口径', () => {
  it('认不出的行 → 单独 nativeOnly 段，兜底形 = `未识别语句 · <原文>`（恒非原样回显）', () => {
    // 选一条两条 pass 都生拒、且不属于任何已知结构（注释/SKIP/PRINT/@头/#声明）的真未知语句做靶
    const src = 'SOME_UNKNOWN_ENGINE_THING 1';
    const r = project(src);
    expect(nativeSegs(r.segments)).toHaveLength(1);
    const seg = nativeSegs(r.segments)[0]!;
    expect(seg.fromLine).toBe(1);
    expect(seg.toLine).toBe(1);
    expect(seg.sugarText).toBe('未识别语句 · SOME_UNKNOWN_ENGINE_THING 1');
    expect(isVerbatimNativeLine(seg.sugarText, src)).toBe(false);
  });

  it('真糖段一个 `nativeOnly` 字段都不带（additive 契约：旧消费方零改动、不靠文本猜第二份口径）', () => {
    const r = project('PRINTFORMW 「甲」\nCALL UNRECOGNIZED_FN\nPRINTFORMW 「乙」');
    expect(sugarSegs(r.segments).every((s) => s.nativeOnly === undefined)).toBe(true);
    expect(nativeSegs(r.segments).every((s) => s.nativeOnly === true)).toBe(true);
  });

  it('相邻段可以无间隔（契约不变量已放开）：native 段与真糖段交替拼满整份文件', () => {
    const src = 'CALL AAA_FN\nPRINTFORMW 「甲」\nCALL BBB_FN\nPRINTFORMW 「乙」';
    const r = project(src);
    expect(r.segments.map((s) => [s.fromLine, s.toLine, s.nativeOnly === true])).toEqual([
      [1, 1, true],
      [2, 2, false],
      [3, 3, true],
      [4, 4, false],
    ]);
    // 相邻无间隔：无一行"原样保留"夹在段外
    for (let i = 1; i < r.segments.length; i++) {
      expect(r.segments[i - 1]!.toLine + 1).toBe(r.segments[i]!.fromLine);
    }
  });

  it('多行连续 native → 一段多行呈现；行与周围真糖段同一把缩进尺（`ctx.indentAt` + 缩进补正）', () => {
    // `SIF A` 的管辖行缩进 +1（批 H 同一口径作用在 native 行上）→ 段内按最小层归一：
    // 第一行带外层缩进、第二行顶格——与它周围的糖文读感一致。
    // pass 已活的合流注：`CALL` 命中 ZH-S 中文形，但行仍属 native 段（接线的分野不变）。
    const r = project(['SIF A', '\tCALL AAA_FN', '\tCALL BBB_FN'].join('\n'));
    expect(nativeSegs(r.segments).map((s) => s.sugarText.split('\n'))).toEqual([
      ['\t调用 AAA_FN', '调用 BBB_FN'],
    ]);
  });

  it('pass 命中 → 不落兜底形：桩态（全 pass 返 null）下 native 行 = 前缀 + 原文，逐字不等（结构判据钉住接线）', () => {
    // 全 pass 返 null 是分支条件之一（基座上 pass 还是桩，正好走这条）：
    // 兜底形恒 = `未识别语句 · 原文`，与对应源行**逐字不等** ⇒ 尺子在本形态下命中 0。
    // 将来 pass 落地后，命中行会是中文形（同样非原样），本判据照常成立。
    const src = ['@M_KOJO_MESSAGE_COM_K1_310', 'CALL FN_A', 'JUMP ENDPLACE'].join('\n');
    const r = project(src);
    expect(r.segments).toHaveLength(1); // 三行连续 native → 一段
    const seg = nativeSegs(r.segments)[0]!;
    expect([seg.fromLine, seg.toLine]).toEqual([1, 3]);
    const lines = seg.sugarText.split('\n');
    expect(lines).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(isVerbatimNativeLine(lines[i]!, split(src)[i] ?? '')).toBe(false);
    }
  });
});

/* ============================================================================
 * 二、红线尺子：零整行原样 ERB（含负自证）
 * ========================================================================== */

describe('红线尺子 · 对位拼接后 zero 整行原样 ERB', () => {
  /** 本 battery 覆盖 buildRecs 里全部 native() 成因（`other` / `unsupported-control-flow` /
   *  `unsupported-print-variant` / `data-or-skip` / `inline-condition`）。 */
  const BATTERY = [
    '@M_KOJO_MESSAGE_COM_K1_310',
    'TFLAG:193 = 1',
    'CALL M_KOJO_K101_HELPER',
    'SETBIT RESULT, 5',
    'SETCOLOR 0xFF8080',
    'PRINTBUTTON "[回去]", "0"',
    'FOR LOCAL, 1, 3',
    '\tPRINTFORMW 循环内',
    'NEXT',
    'IF',
    '\tPRINTFORML 触发"IF 表达式缺失"的 native',
    'ENDIF',
    '$label_start',
    'JUMP label_start',
    '#DIM 计数 3',
    'PRINTDATAL',
    'PRINTFORML 触发"数据表体内 PRINT 系"的 native',
    'ENDDATA',
    'PRINTFORMW 半途 \\@ A ? x # y \\@ 触发 inline-condition 的行 \\@',
  ].join('\n');

  it('对位拼接（段内用 sugarText、段外回显原文）后 `countVerbatimNativeLines` = 0', () => {
    const r = project(BATTERY);
    const doc = composeLikeHost(BATTERY, r.segments);
    const m = countVerbatimNativeLines(doc, split(BATTERY));
    expect(m.count).toBe(0); // 红线：一整行原样 ERB 一行都不许有
    expect(nativeSegs(r.segments).length).toBeGreaterThan(0); // 证明确实走了兜底路
  });

  it('负自证：把兜底行改回原文 ⇒ 尺子从 0 变 1（证明读数真的在数）', () => {
    const src = 'CALL AAA_FN\nPRINTFORMW 「甲」';
    const r = project(src);
    const doc = composeLikeHost(src, r.segments);
    expect(countVerbatimNativeLines(doc, split(src)).count).toBe(0);
    const broken = [...doc];
    broken[0] = split(src)[0]!; // 改坏一行 = 原样回贴
    const m = countVerbatimNativeLines(broken, split(src));
    expect(m.count).toBe(1);
    expect(m.lines).toEqual([0]);
  });

  it('尺子自身的口径：兜底前后缀变化 / 缩进差异都不触发，逐字相同才触发', () => {
    expect(isVerbatimNativeLine('未识别语句 · RETURN 1', 'RETURN 1')).toBe(false);
    expect(isVerbatimNativeLine('\t未识别语句 · RETURN 1', 'RETURN 1')).toBe(false);
    expect(isVerbatimNativeLine('IF LOCAL', 'IF LOCAL')).toBe(true); // 反例：这一行此刻就是红线
  });
});

/* ============================================================================
 * 三、RETURN 骨架吸收（红线 2）——各形态与边界
 * ========================================================================== */

describe('RETURN 吸收 · 函数体内任何单独成行的 RETURN 永不上屏', () => {
  it('IF/ENDIF 之间的早退（旧口径漏网处）→ 不上屏；函数体其余行照常投影', () => {
    const src = ['@M_FN', 'IF A', '\tRETURN 1', 'ENDIF', 'RETURN 1'].join('\n');
    const r = project(src);
    const doc = composeLikeHost(src, r.segments).map((l) => l.trim());
    expect(doc).not.toContain('RETURN 1');
    expect(doc).not.toContain('RETURN');
    // 函数体之外的可见线仍在
    expect(doc).toContain('如果 A：');
  });

  it('磁盘一字不动（账要平不静默）：`RETURN` 只在投影显示里消失，行本身仍在统计里入账', () => {
    const src = ['@M_FN', 'LOCAL = 1', 'IF LOCAL', 'PRINTFORMW 「甲」', 'ENDIF', 'RETURN 1'].join('\n');
    const { stats } = project(src);
    // 三类之和恒等于总行数——被吸收的行计入 projected（control），没有凭空消失
    expect(stats.projectedLines + stats.passthroughLines + stats.nativeLines).toBe(stats.totalLines);
    expect(stats.totalLines).toBe(6);
    expect(stats.nativeLines).toBe(1); // 只有未标记的函数头 `@M_FN` 兜底一行
    const r2 = project(src);
    expect(composeLikeHost(src, r2.segments).join('\n')).not.toContain('RETURN 1');
  });

  it('函数体外的 `RETURN`（文件头区 / 无 `@` 头）不是骨架 → 不吸收，native 口径照样显示', () => {
    // 不算骨架 ⇒ 不进吸收表；native 行照常成段上屏。pass 已活的合流注：命中 ZH-S → `返回 1`。
    const r = project(['PRINTFORMW 「甲」', 'RETURN 1'].join('\n'));
    expect(nativeSegs(r.segments).map((s) => s.sugarText)).toEqual(['返回 1']);
  });

  it('包装三联的 `RETURN`（原口径的两处吸收点）→ 与骨架一致照旧不显示', () => {
    const src = ['@A', 'CALL A_1', 'RETURN RESULT', '@A_1', 'PRINTFORMW 「甲」'].join('\n');
    const r = project(src);
    expect(composeLikeHost(src, r.segments).join('\n')).not.toContain('RETURN');
    expect(composeLikeHost(src, r.segments).join('\n')).not.toContain('CALL A_1');
  });

  it('`[SKIPSTART]` 停用区里的 `RETURN` 不吸收——停用区显示为结构标签，正文保留为 `停用 · 原文`（1:1）', () => {
    const src = ['[SKIPSTART]', 'RETURN 1', '[SKIPEND]', 'RETURN 2'].join('\n');
    const r = project(src);
    const doc = composeLikeHost(src, r.segments);
    // 停用区是已知结构：首尾标签显式可见（不是"未识别语句"），正文保留可读但不吸成糖
    expect(doc.join('\n')).toContain('停用区（引擎不执行）');
    expect(doc.join('\n')).toContain('停用 · RETURN 1');
    expect(doc.join('\n')).toContain('停用区（结束）');
    expect(doc).not.toContain('返回 1');
    expect(doc.join('\n')).toContain('返回 2'); // 区外 RETURN 照常上屏（pass 命中 → `返回 2`）
    expect(doc.join('\n')).not.toContain('\nRETURN 2'); // 任何形态下整行原样 ERB 都不许出现
  });

  it('行尾注释剥离后再判：`RETURN 1 ; 说明` 与裸 `RETURN` 同样吸收', () => {
    const src = ['@M_FN', 'RETURN 1 ; 尽早退场'].join('\n');
    const r = project(src);
    expect(composeLikeHost(src, r.segments).join('\n')).not.toContain('RETURN 1');
    const bareSrc = ['@M_FN', 'RETURN'].join('\n');
    const bare = project(bareSrc);
    expect(composeLikeHost(bareSrc, bare.segments).join('\n')).not.toContain('RETURN');
  });

  it('冒号连写（`SIF A: RETURN`）不属"单独成行"→ 不进吸收表，native 口径使它不再原样上屏', () => {
    const src = ['@M_FN', 'SIF A: RETURN', 'PRINTFORMW 「乙」'].join('\n');
    const r = project(src);
    const doc = composeLikeHost(src, r.segments);
    // 整行逐字等号的判据：源行本身一行不许出现；pass 已活的合流注：控制 pass 命中 → `如果 A 则 RETURN`
    expect(doc.every((l) => l !== 'SIF A: RETURN')).toBe(true);
    expect(doc.join('\n')).toContain('如果 A 则 RETURN');
  });

  it('`RETURNF <值>` 是作者写的返回值 → 显示 `返回 <值>`；裸 `RETURNF` → `返回`；行尾注释剥离', () => {
    const src = ['@M_VALUE_FN', 'RETURNF ARG + 1', '\tRETURNF', 'RETURNF RESULT ; 收束也照显'].join('\n');
    const r = project(src);
    const doc = composeLikeHost(src, r.segments);
    expect(doc[0]).toBe('函数 · @M_VALUE_FN');
    expect(doc[1]).toBe('返回 ARG + 1');
    expect(doc[2]?.trim()).toBe('返回');
    expect(doc[3]?.trim()).toBe('返回 RESULT');
    expect(doc).not.toContain('RETURNF');
  });
});

/* ============================================================================
 * 四、MESSAGECHECK 数字返回不被骨架吸收吃掉
 * ========================================================================== */

describe('MESSAGECHECK 数字返回 · 骨架吸收的位置约束', () => {
  it('MECHECK 体内的 `RETURN 1/2/3` 先走协议注记（`隐藏情景（数字返回 1）：`），不被吸收吞掉', () => {
    const src = ['@M_KOJO_MESSAGE_MESSAGECHECK_COM_K1_310', 'IF TFLAG:193', '\tRETURN 1', 'ENDIF', 'RETURN 3'].join('\n');
    const r = withFaces(src);
    const text = sugarSegs(r.segments).map((s) => s.sugarText).join('\n');
    expect(text).toContain('如果 TFLAG:193：');
    expect(text).toContain('隐藏情景（数字返回 1）：');
    expect(text).toContain('隐藏情景 · 隐藏口上（数字返回 3）：');
  });

  it('对照：MECHECK 体内 `RETURN 0`（无子句可标）→ 不显示注记，也不原样上屏（骨架吸收着陆）', () => {
    const src = ['@M_KOJO_MESSAGE_MESSAGECHECK_COM_K1_310', 'IF TFLAG:193', '\tRETURN 0', 'ENDIF'].join('\n');
    const r = withFaces(src);
    const doc = composeLikeHost(src, r.segments);
    expect(doc.join('\n')).toContain('如果 TFLAG:193：');
    expect(doc.every((l) => l !== 'RETURN 0' && l !== 'RETURN 0 尽早退场')).toBe(true);
    expect(doc.every((l) => isVerbatimNativeLine(l, split(src)[doc.indexOf(l)] ?? '') === false)).toBe(true);
  });
});
