/**
 * E13 批 · 段块糖（`若 <ERB条件>：`；1016 批只留 `若` 一词形，旧形 `段` / `section` 已删）
 * + 投影**段级吸收** + 投影标签可写回。
 *
 * E13 报红的原话是「把投影结果原样贴进 `.kojo` 保存」期望**零 error**。所以本文件的
 * 主判据不是"产了几行"，而是三段闭环：
 *   ①写侧：`若` 的产物逐字等于库内手写的信封段（`docs/SUGAR-INTIMATE-EXPANSION-PROPOSAL.md` §3 P-1）；
 *   ②投影侧：一个函数里重复 N 次的信封**每一段**都折回 `若` 头（不是只折最外层）；
 *   ③闭环：投影产物喂回转译器 ⇒ 零 error（可写性守卫，判据同源
 *   `eratw-adapter/tests/scaffold-cases.test.ts`）。
 *
 * 1016 批删去 `（关）` 停用标记：写侧每段的 `LOCAL` 恒为 `1`；投影侧 **`LOCAL = 0` 信封
 * 一律不折**（照折会把作者的"停用"静默改成"启用"）⇒ 它留成一行原码并切断段，与同函数的
 * `若` 段混排。CR-1 把这一情形的回退单位从"整个函数"降到"**这一段折叠**"（`若` 全部退回
 * `如果 …：`，台词行一行不退）——见下方"混排"与"闭环②③"三条用例。
 *
 * 装配不依赖游戏盘（字典/分野表用 `support.ts` 的桩）；真语料那条单独 skip。
 * **每条正向断言都配负自证**——改一个字符 / 去掉块头必须被抓出，防断言空转。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ControlFlowStatement, SugarDiagnostic } from '@kojo/plugin-api';
import { scanControlFlow } from '@kojo/plugin-erb-parser';
import { createSugarTranspileService } from '../src/service';
import { liftProject } from '../src/project';
import type { LiftDeps } from '../src/lift';
import { stubDict, stubFaceTable } from './support';

/* ================================ 装配夹具 ================================ */

const svc = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/**
 * 投影片段只含糖正文：宿主文件头的 `角色:` 不在片段里，单测回灌时补一行最小声明。
 * `角色:` 是必填头声明（函数名带 `_K{n}`）；这里用 12 与 fixture 的 `_K12` 函数头同源。
 * 片段自己带了头声明（`角色:` / `口上:` 等完整文件）则原样返回。
 */
const withCharNo = (src: string): string =>
  /^[ \t]*角色\s*[:：]/m.test(src) ? src : `角色: 12\n${src}`;

const errsOf = (src: string): SugarDiagnostic[] =>
  svc().transpile(withCharNo(src)).diagnostics.filter((d) => d.severity === 'error');
const codesOf = (src: string): string[] => errsOf(src).map((d) => d.code);
const productOf = (src: string): string => svc().transpile(withCharNo(src)).erb;

/** 正文落在 `时机 绝顶：` 的函数体内（stub 表 → `@M_KOJO_MESSAGE_PALAMCNG_B_K12`） */
const doc = (body: string): string => `角色: 12\n时机 绝顶：\n${body}\n`;

/** 取产物里**正文函数**那一段（`@…_1` 头起），去掉包装三联 */
function bodyOf(erb: string, fn = '@M_KOJO_MESSAGE_PALAMCNG_B_K12_1'): string[] {
  const ls = erb.replace(/\r\n/g, '\n').split('\n');
  const start = ls.findIndex((l) => l.trim() === fn);
  if (start < 0) throw new Error(`产物里没有 ${fn}：\n${erb}`);
  return ls.slice(start).filter((l) => l.trim().length > 0);
}

const projectDeps = (): LiftDeps => ({
  transpile: () => {
    throw new Error('投影不应调用 transpile');
  },
  scanControlFlow: (t: string): ControlFlowStatement[] => scanControlFlow(t),
  faceTable: () => stubFaceTable(),
});
const project = (source: string) => liftProject(projectDeps(), { source });
const segText = (source: string): string[] =>
  project(source).segments.map((s) => s.sugarText);

/**
 * **按宿主的做法**把投影产物拼回原文：段区间换成 `sugarText`，其余行原样。
 *
 * E13 报红的原话是"把投影结果原样贴进 `.kojo` 保存"期望零 error——只看 `sugarText`
 * 拼接（`segText`）测不出"原生行留在两段之间"这种形态，而那正是 CR-1 回退判据要防的
 * 唯一真实危害。故闭环一律走这一条：拼出来的整份文件必须能被转译器**无 error** 收下。
 */
function composeLikeHost(
  source: string,
  segments: ReadonlyArray<{ fromLine: number; toLine: number; sugarText: string }>,
): string {
  const src = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let cur = 1;
  for (const s of segments) {
    for (; cur < s.fromLine; cur++) out.push(src[cur - 1]!);
    if (s.sugarText.length > 0) out.push(...s.sugarText.split('\n'));
    cur = s.toLine + 1;
  }
  for (; cur <= src.length; cur++) out.push(src[cur - 1]!);
  return out.join('\n');
}

/* ============================================================================ */
/* A. 写侧：段块的产物必须是库内手写的样子                                          */
/* ============================================================================ */

describe('E13-A 写侧 · 段块产物逐字', () => {
  const src = doc('\t若 NOWEX:噴乳：\n\t\t「涩涩的话」\n\t若 TFLAG:193：\n\t\t「日常的对话」\n');

  it('两段 → 逐段信封；每段 `LOCAL = 1`；`RETURN 1` 全函数只一次', () => {
    expect(errsOf(src)).toEqual([]);
    expect(bodyOf(productOf(src))).toEqual([
      '@M_KOJO_MESSAGE_PALAMCNG_B_K12_1',
      ';-------------------------------------------------',
      ';NOWEX:噴乳（記入チェック＝1）',
      'LOCAL = 1',
      ';-------------------------------------------------',
      'IF LOCAL && NOWEX:噴乳',
      '\tPRINTFORMW 「涩涩的话」',
      'ENDIF',
      ';-------------------------------------------------',
      ';TFLAG:193（記入チェック＝1）',
      'LOCAL = 1',
      ';-------------------------------------------------',
      'IF LOCAL && TFLAG:193',
      '\tPRINTFORMW 「日常的对话」',
      'ENDIF',
      'RETURN 1',
    ]);
  });

  it('段块**不吃**外层 `IF LOCAL` 信封（每段自带守卫，多包一层就是双重条件）', () => {
    const bare = doc('\t如果 NOWEX:噴乳：\n\t\t「甲」\n');
    // 普通正文：外层信封在（`@…_1` 之后紧跟 `;記入チェック（=0…` 与裸 `IF LOCAL`）
    expect(productOf(bare)).toContain('\nIF LOCAL\n');
    // 段块：一个裸 `IF LOCAL` 都不许有
    expect(productOf(src)).not.toMatch(/^IF LOCAL$/m);
  });

  it('负自证：去掉 `若` 关键字 ⇒ 块头不成立，缩进的正文立刻报红（不是静默少一层）', () => {
    const broken = doc('\tNOWEX:噴乳：\n\t\t「涩涩的话」\n');
    expect(codesOf(broken)).toContain('indent-mismatch');
  });

  it('负自证：段体不缩进 ⇒ 该段没有正文，报 error 不产空段', () => {
    const flat = doc('\t若 NOWEX:噴乳：\n\t「涩涩的话」\n');
    expect(codesOf(flat)).toContain('block-empty');
  });
});

describe('P-1R 语言表层 · 唯一词形 `若` / 旧形已删 / 头位闸', () => {
  const legacySeg = doc('\t段 NOWEX:噴乳：\n\t\t「甲」\n');
  const legacySec = doc('\tsection NOWEX:放尿：\n\t\t「甲」\n');

  it('负自证：旧形 `段` 不再是段头（1016 批删去）⇒ 块头不成立、缩进正文报红', () => {
    expect(productOf(legacySeg)).not.toContain('IF LOCAL && ');
    expect(codesOf(legacySeg)).toContain('indent-mismatch');
  });

  it('负自证：英文 `section` 也不再是段头（糖面零英文 token，随旧形一并删）', () => {
    expect(productOf(legacySec)).not.toContain('IF LOCAL && ');
    expect(codesOf(legacySec)).toContain('indent-mismatch');
  });

  it('负自证：行尾 `（关）` 不再被当停用后缀（表层已无停用标记）⇒ 不产 `LOCAL = 0`', () => {
    // `（关）` 现在是段条件的一部分（不是标记）；无论条件降糖成什么，都不许出现 `LOCAL = 0`
    expect(productOf(doc('\t若 NOWEX:噴乳（关）：\n\t\t「甲」\n'))).not.toContain('LOCAL = 0');
  });

  it('负自证：行尾独立 `关` 也不再被当停用后缀 ⇒ 不产 `LOCAL = 0`', () => {
    expect(productOf(doc('\t若 TFLAG:193 关：\n\t\t「甲」\n'))).not.toContain('LOCAL = 0');
  });

  it('条件里的 `非 X` = **逻辑否定**（不是停用态）：`LOCAL = 1` + `IF LOCAL && !X`', () => {
    expect(errsOf(doc('\t若 非 NOWEX:噴乳：\n\t\t「甲」\n'))).toEqual([]);
    const lines = bodyOf(productOf(doc('\t若 非 NOWEX:噴乳：\n\t\t「甲」\n')));
    expect(lines).toContain('LOCAL = 1'); // 否定 ≠ 停用 ⇒ 仍是 1
    expect(lines).toContain('IF LOCAL && ! NOWEX:噴乳');
  });

  it('负自证：伪头「若干年后：」不是段头（首词非独立关键字 ⇒ 落回普通文本）', () => {
    const pseudo = doc('\t若干年后：\n\t\t「甲」\n');
    expect(productOf(pseudo)).not.toContain('IF LOCAL && '); // 没折出段信封
    expect(codesOf(pseudo)).toContain('indent-mismatch');
  });

  it('负自证：`若` 必须行尾**全角** `：`（半角 `:` 落回普通行）', () => {
    const half = doc('\t若 NOWEX:噴乳:\n\t\t「甲」\n');
    expect(productOf(half)).not.toContain('IF LOCAL && ');
    expect(codesOf(half)).toContain('indent-mismatch');
  });

  it('负自证：`非 首次` 无意义（保留段名整串匹配）⇒ 报 `unknown-identifier`', () => {
    expect(codesOf(doc('\t若 非 首次：\n\t\t「甲」\n'))).toContain('unknown-identifier');
  });
});

describe('E13-A 写侧 · 段条件与 `如果` 同源（不另造一套条件语法）', () => {
  it('`若 她的恋慕 >= 1：` 的条件降糖 == `如果 她的恋慕 >= 1：`', () => {
    const asIf = bodyOf(productOf(doc('\t如果 她的恋慕 >= 1：\n\t\t「甲」\n'))).find((l) => l.startsWith('IF '));
    const asSec = bodyOf(productOf(doc('\t若 她的恋慕 >= 1：\n\t\t「甲」\n'))).find((l) => l.startsWith('IF '));
    expect(asIf).toBe('IF LOCAL'); // 普通正文的条件写在信封里那层
    expect(asSec).toBe('IF LOCAL && TALENT:TARGET:恋慕 >= 1');
  });

  it('负自证：段条件里拼错的标识符照样 `unknown-identifier`（白名单没被段头绕开）', () => {
    expect(codesOf(doc('\t若 噴乳乳瞎写：\n\t\t「甲」\n'))).toContain('unknown-identifier');
  });

  it('负自证：`关` 只是条件的一部分（不再是尾随标记）⇒ `若 NOWEX:噴乳关：` 产 `LOCAL = 1`', () => {
    const merged = bodyOf(productOf(doc('\t若 NOWEX:噴乳关：\n\t\t「甲」\n')));
    // 没被当成禁用标记 ⇒ 仍是 LOCAL = 1，且条件里带着那个 `关`（原样进产物，不静默改名）
    expect(merged).toContain('LOCAL = 1');
    expect(merged).toContain('IF LOCAL && NOWEX:噴乳关');
  });
});

describe('E13-A 写侧 · 骨架冲突一律 fail-closed（不拼半成品）', () => {
  it('段与普通语句混排 → `section-mixed`，且**不产出正文函数**', () => {
    const mixed = doc('\t若 NOWEX:噴乳：\n\t\t「甲」\n\t「乙」\n');
    expect(codesOf(mixed)).toContain('section-mixed');
    expect(productOf(mixed)).not.toContain('@M_KOJO_MESSAGE_PALAMCNG_B_K12_1');
  });

  it('段内再写段 → `section-nested`（库内信封段是同层的）', () => {
    const nested = doc('\t若 NOWEX:噴乳：\n\t\t若 TFLAG:193：\n\t\t\t「甲」\n');
    expect(codesOf(nested)).toContain('section-nested');
  });

  it('负自证：段体里用 `如果` 分叉是**合法**的（不许把嵌套判据放宽成"段内不许有块"）', () => {
    expect(codesOf(doc('\t若 NOWEX:噴乳：\n\t\t如果 TFLAG:193：\n\t\t\t「甲」\n'))).toEqual([]);
  });
});

/* ============================================================================ */
/* A2. P-3 初回段（保留段名 `首次`）——整串硬编译                                     */
/* ============================================================================ */

describe('P-3 初回段 · 保留段名 `首次` 整串硬编译', () => {
  const src = doc('\t若 首次：\n\t\t「涩涩的话」\n');

  it('产物 = `LOCAL:1 = 1` + `IF LOCAL:1 && FIRSTTIME(SELECTCOM)`（不经 lowerExpression）', () => {
    // `首次` 裸词不是可解析标识符、`SELECTCOM` 在糖表达式里也接不住 ⇒ 若走常规段管线会报
    // `unknown-identifier`；此处硬编译 ⇒ 零 error。每段 `check` 恒为 1。
    expect(errsOf(src)).toEqual([]);
    expect(bodyOf(productOf(src))).toEqual([
      '@M_KOJO_MESSAGE_PALAMCNG_B_K12_1',
      'LOCAL:1 = 1',
      'IF LOCAL:1 && FIRSTTIME(SELECTCOM)',
      '\tPRINTFORMW 「涩涩的话」',
      'ENDIF',
      'RETURN 1',
    ]);
  });

  it('负自证：`若 首次（关）：` 不再命中保留段名（`（关）` 是条件的一部分）⇒ 不产 `LOCAL:1 = 0`', () => {
    expect(productOf(doc('\t若 首次（关）：\n\t\t「甲」\n'))).not.toContain('LOCAL:1 = 0');
  });

  it('负自证：普通段 `LOCAL = 1` 形没被改坏（保留段名分支不吞普通段）', () => {
    const plain = doc('\t若 NOWEX:噴乳：\n\t\t「甲」\n');
    expect(errsOf(plain)).toEqual([]);
    const lines = bodyOf(productOf(plain));
    expect(lines).toContain('LOCAL = 1');
    expect(lines).toContain('IF LOCAL && NOWEX:噴乳');
    // 普通段不许冒出 `LOCAL:` 子信封口径
    expect(lines.some((l) => l.startsWith('LOCAL:'))).toBe(false);
  });
});

/* ============================================================================ */
/* B. 投影侧：段级吸收（E13-2 的真正病灶）                                          */
/* ============================================================================ */

describe('E13-B 投影 · 段级吸收', () => {
  /** 库内形态：一个函数里三个信封段（**全启用**，`LOCAL = 1`） */
  const threeEnabled = [
    '@M_KOJO_MESSAGE_PALAMCNG_B_K12',
    ';-------------------------------------------------',
    ';噴乳',
    'LOCAL = 1',
    ';-------------------------------------------------',
    'IF LOCAL && NOWEX:噴乳',
    '\tPRINTFORMW 「甲」',
    'ENDIF',
    ';-------------------------------------------------',
    ';射精',
    'LOCAL = 1',
    ';-------------------------------------------------',
    'IF LOCAL && NOWEX:射精',
    '\tPRINTFORMW 「乙」',
    'ENDIF',
    ';-------------------------------------------------',
    ';放尿',
    'LOCAL = 1',
    ';-------------------------------------------------',
    'IF LOCAL && NOWEX:放尿',
    '\tPRINTFORMW 「丙」',
    'ENDIF',
    'RETURN 1',
  ].join('\n');

  /** 混排：启用段 + 停用段（`LOCAL = 0`，作者的"停用占位"） */
  const mixedOff = [
    '@M_KOJO_MESSAGE_PALAMCNG_B_K12',
    ';-------------------------------------------------',
    ';噴乳',
    'LOCAL = 1',
    ';-------------------------------------------------',
    'IF LOCAL && NOWEX:噴乳',
    '\tPRINTFORMW 「甲」',
    'ENDIF',
    ';-------------------------------------------------',
    ';射精',
    'LOCAL = 0',
    ';-------------------------------------------------',
    'IF LOCAL && NOWEX:射精',
    '\tPRINTFORMW 「乙」',
    'ENDIF',
    'RETURN 1',
  ].join('\n');

  it('每段都折成 `若 …：`，**不是只折最外层**（全启用段）', () => {
    const text = segText(threeEnabled).join('\n');
    expect(text).toContain('若 NOWEX:噴乳：');
    expect(text).toContain('若 NOWEX:射精：');
    expect(text).toContain('若 NOWEX:放尿：');
    // 信封的机器码一行都不许留下（留下了就是 E13 报红的原样）
    expect(text).not.toContain('LOCAL = 1');
    expect(text).not.toContain('IF LOCAL');
    expect(text).not.toContain('ENDIF');
    // 表层已无停用标记
    expect(text).not.toContain('（关）');
  });

  it('段体**不额外减缩进**（段头落在原 `IF` 那一行，正文本来就比它深一层）', () => {
    const lines = segText(threeEnabled).join('\n').split('\n');
    const tabs = (l: string): number => /^\t*/.exec(l)![0].length;
    const head = lines.findIndex((l) => l.trim() === '若 NOWEX:噴乳：');
    expect(head).toBeGreaterThanOrEqual(0);
    // 只钉**相对**层级：紧跟段头的正文恰比段头深一级（绝对列数由 `时机` 头决定，不是本判据）
    expect(lines[head + 1]!.trim()).toBe('「甲」');
    expect(tabs(lines[head + 1]!)).toBe(tabs(lines[head]!) + 1);
  });

  it('纯 `IF LOCAL`（外层信封）仍走原吸收，**不多出一个 `若`**', () => {
    const plain = [
      '@M_KOJO_MESSAGE_PALAMCNG_B_K12',
      'LOCAL = 1',
      'IF LOCAL',
      '\tPRINTFORMW 「甲」',
      'ENDIF',
      'RETURN 1',
    ].join('\n');
    const text = segText(plain).join('\n');
    expect(text).toContain('时机 绝顶：');
    expect(text).not.toContain('若 ');
  });

  it('负自证①：`ENDIF` 配不上（段没闭合）→ **不折叠**，机器码留在原行里', () => {
    const unclosed = ['@M_KOJO_MESSAGE_PALAMCNG_B_K12', 'LOCAL = 1', 'IF LOCAL && NOWEX:噴乳', '\tPRINTFORMW 「甲」'].join(
      '\n',
    );
    const r = project(unclosed);
    expect(r.segments.map((s) => s.sugarText).join('\n')).not.toContain('若 NOWEX');
    // 未被吸收 ⇒ 那三行仍在"保留原生"的成因计数里（不静默吞掉）
    expect(r.stats.projectedLines).toBeLessThan(4);
  });

  it('负自证②：片段级投影（往上没有函数头）→ 不折叠（"上无函数头就不动"底线）', () => {
    const fragment = ['LOCAL = 1', 'IF LOCAL && NOWEX:噴乳', '\tPRINTFORMW 「甲」', 'ENDIF'].join('\n');
    expect(segText(fragment).join('\n')).not.toContain('若 NOWEX:噴乳：');
  });

  it('负自证③：**`LOCAL = 0` 纯信封不折**（值 0 一律不折）⇒ 机器码留原生、无 `若`', () => {
    const disabledPlain = [
      '@M_KOJO_MESSAGE_PALAMCNG_B_K12',
      'LOCAL = 0',
      'IF LOCAL',
      '\tPRINTFORMW 「甲」',
      'ENDIF',
      'RETURN 1',
    ].join('\n');
    const text = segText(disabledPlain).join('\n');
    // 不折成段（值 0 的信封绝不变成与启用段同形的 `若 <条件>：`）
    expect(text).not.toContain('若 ');
    // 信封整体**没被吸收**：`LOCAL = 0` 那行留原生（不产糖行），`IF LOCAL` 退化成普通条件块
    // （不是被拆掉的信封——否则这里不会还剩一个 `如果 LOCAL：`）
    expect(text).toContain('如果 LOCAL：');
    // 更没被改写成启用态：`LOCAL = 1` 一个都不许冒（否则就是把"停用"悄悄改成"启用"）
    expect(text).not.toContain('LOCAL = 1');
  });

  it('混排（启用段 + 停用段）：**只回退"折叠"本身**，一行台词都不陪葬（CR-1）', () => {
    // 停用段（`LOCAL = 0`）不折 ⇒ 它在「时机」顶层留成一行原码 ⇒ 与 `若` 段混排（写侧没有
    // 唯一可写回形状）。旧实现据此把**整个函数**打回原生直通：一个 `LOCAL = 0` 抹掉全函数台词。
    // CR-1 把回退单位降到"段折叠"——函数里 `若` 一个不留（混排判据照常成立），
    // 但每一行照常按各自口径投影：`LOCAL = 0` 留原码、`IF …` 降成 `如果 …：`、台词行降成文本行。
    const r = project(mixedOff);
    const text = r.segments.map((s) => s.sugarText).join('\n');
    expect(text).not.toContain('若 ');
    // 台词行**不退**：两条段的正文都还在糖段里
    expect(text).toContain('「甲」');
    expect(text).toContain('「乙」');
    // 函数头照常反解成「时机 …：」（旧实现连它一起抹掉）
    expect(text).toContain('时机 绝顶：');
    // 机器码一行都没被吞、也没被改写：`LOCAL` 行在拼接产物里**逐字还是源里那两行**
    // （停用态没被悄悄翻成启用态——1016 批立的红线）
    const composed = composeLikeHost(mixedOff, r.segments);
    expect(composed.split('\n').filter((l) => /LOCAL\s*=/.test(l))).toEqual(['LOCAL = 1', 'LOCAL = 0']);
    // 不再是零糖段
    expect(r.segments.length).toBeGreaterThan(0);
    expect(r.stats.projectedLines).toBeGreaterThan(0);
  });

  it('闭环②：混排回退后的产物**不再有 `section-*` 结构诊断**（CR-1 的判据本体）', () => {
    // 回退要防的是"半个坏投影"——具体就是段块与普通正文混在一个「时机」顶层所产生的
    // `section-mixed` / `section-unclosed` / `section-nested`。回退把 `若` 全换成 `如果`
    // 之后这三类一个都不该剩。
    // （对照事实：`indent-mismatch` 是**逐段缩进重新基准**的既有显示近似——非段式函数被
    // 原生行切开时同样会出现，HEAD 版本实测即报，不是本条判据要挡的东西，也不是写盘路径。）
    const r = project(mixedOff);
    const composed = composeLikeHost(mixedOff, r.segments);
    expect(codesOf(composed).filter((c) => c.startsWith('section-'))).toEqual([]);
  });

  it('闭环③：段体内有投不了的行（`CALL`）⇒ 该段退回 `如果 …：`，台词行一行不退', () => {
    const src = [
      '@M_KOJO_MESSAGE_PALAMCNG_B_K12',
      'LOCAL = 1',
      'IF LOCAL && NOWEX:噴乳',
      '\tPRINTFORMW 「甲」',
      '\tCALL SOMEThing',
      'ENDIF',
      'LOCAL = 1',
      'IF LOCAL && NOWEX:射精',
      '\tPRINTFORMW 「乙」',
      'ENDIF',
      'RETURN 1',
    ].join('\n');
    const r = project(src);
    const text = r.segments.map((s) => s.sugarText).join('\n');
    // `CALL` 在段体里 ⇒ 这条折叠被撤（否则 `若` 头与它的正文被一行原生代码切开）
    expect(text).toContain('如果 LOCAL && NOWEX:噴乳：');
    expect(text).not.toContain('若 ');
    // 两条段的台词都还在糖里（旧实现这里 `segs=0`，两行台词一起陪葬）
    expect(text).toContain('「甲」');
    expect(text).toContain('「乙」');
    // 撤折叠≠吞内容：`CALL` 那行仍以原生形态出现在拼接产物里（没被折掉、也没被删）
    expect(composeLikeHost(src, r.segments)).toContain('CALL SOMEThing');
    expect(codesOf(composeLikeHost(src, r.segments)).filter((c) => c.startsWith('section-'))).toEqual([]);
  });

  it('闭环：多信封函数（全启用）投影 → 原样喂回转译器 ⇒ **零 error**（E13 的判据本体）', () => {
    const text = segText(threeEnabled).join('\n');
    expect(errsOf(text)).toEqual([]);
    // 折回去还长得回原来的信封段（写读同形）
    const erb = productOf(text);
    expect(erb).toContain('IF LOCAL && NOWEX:噴乳');
    expect(erb).toContain('IF LOCAL && NOWEX:射精');
    expect(erb).toContain('IF LOCAL && NOWEX:放尿');
  });
});

/* ============================================================================ */
/* C. E13-1：投影标签必须落在词法器认得的形态上                                     */
/* ============================================================================ */

describe('E13-C 投影标签 · `_1` 委托尾与家族段', () => {
  it('正文函数的 `{i}` 带 M1 委托后缀 `_1` → 标签剥回 `310`（糖一条即产桩+正文）', () => {
    const source = [
      '@M_KOJO_MESSAGE_COM_K12_310',
      'CALL M_KOJO_MESSAGE_COM_K12_310_1',
      'RETURN RESULT',
      '@M_KOJO_MESSAGE_COM_K12_310_1',
      'LOCAL = 1',
      'IF LOCAL',
      '\tPRINTFORMW 「甲」',
      'ENDIF',
      'RETURN 1',
    ].join('\n');
    const text = segText(source).join('\n');
    expect(text).toContain('时机 指令 310：');
    expect(text).not.toContain('310_1');
    expect(errsOf(text)).toEqual([]);
  });

  it('家族段 → 发文件头 `口上:`，块头里一个全角括号都不许有', () => {
    const text = segText('@M_KOJO_少女之梦_EVENT_K12_2\nPRINTFORMW 甲').join('\n');
    expect(text).toContain('口上: 少女之梦');
    expect(text).toContain('时机 事件 2：');
    expect(text).not.toContain('（');
    // 报红的原形态：`时机 事件 2（少女之梦版）：` 被当中文指令名查表 ⇒ 这条必须能过
    expect(errsOf(text)).toEqual([]);
  });

  it('负自证：家族头只发一次，源里已写 `口上:` 就一个都不发', () => {
    const two = [
      '@M_KOJO_少女之梦_EVENT_K12_2',
      'PRINTFORMW 甲',
      '@M_KOJO_少女之梦_EVENT_K12_3',
      'PRINTFORMW 乙',
    ].join('\n');
    expect(segText(two).join('\n').match(/口上: 少女之梦/g)).toHaveLength(1);
    // 源里已有 `口上:` 声明 ⇒ 一个都不补（重复声明会撞规范 §3.1 的"最后一条生效"）
    const declared = ['口上: 少女之梦', '@M_KOJO_少女之梦_EVENT_K12_2', 'PRINTFORMW 甲'].join('\n');
    expect(segText(declared).join('\n')).not.toContain('口上:');
  });
});

/* ============================================================================ */
/* D. 真语料复现函数（语料不在位则 skip；整体只读，零写入）                          */
/* ============================================================================ */

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

/**
 * 真语料定位（**整体只读**，零写入）：语料根经 `KOJO_SMOKE_PROJECT` 给出（约定同
 * `kernel/tests/*corpus*.test.ts`）。改版里 `049 …` 之下的目录层数各家不同
 * （TOKI 那份在 `古明地觉TOKI/古明地觉/`），只有"角色目录 + 文件名"是稳定的 ⇒ 按名字找，
 * 同名多份时优先 TOKI 那份（被测函数 `M_KOJO_TOKI_…` 只活在她家）。
 */
function corpusK49(): string | undefined {
  if (!SMOKE) return undefined;
  const personal = join(SMOKE, 'ERB', '口上・メッセージ関連', '個人口上');
  if (!existsSync(personal)) return undefined;
  const hits: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth === 0 && !ent.name.startsWith('049')) continue;
        walk(p, depth + 1);
      } else if (ent.name === 'M_KOJO_K49_奉仕系コマンド.ERB') {
        hits.push(p);
      }
    }
  };
  walk(personal, 0);
  return hits.find((h) => h.includes('TOKI')) ?? hits[0];
}

const K49 = corpusK49();

describe.skipIf(K49 === undefined)('E13-D 真语料 · E13 报红的复现函数', () => {
  it('`@M_KOJO_TOKI_MESSAGE_COM_K49_88_1` 照抄投影 ⇒ 零 error', () => {
    const raw = readFileSync(K49!, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const start = raw.findIndex((l) => l.trim() === '@M_KOJO_TOKI_MESSAGE_COM_K49_88_1');
    expect(start).toBeGreaterThanOrEqual(0);
    let end = start + 1;
    while (end < raw.length && !/^@/.test(raw[end]!)) end++;
    const fn = raw.slice(start, end).join('\n');

    const text = segText(fn).join('\n');
    // 报红原文两条都得消失：`88_1（TOKI版）` 形态的标签 + `LOCAL = 1` 留在 0 列
    expect(text).toContain('时机 指令 88：');
    expect(text).toContain('口上: TOKI');
    expect(text).not.toMatch(/^LOCAL = /m);
    const errs = errsOf(`角色: 49\n${text}`);
    expect(errs.map((e) => `${e.code} @${e.loc?.line}:${e.loc?.column} ${e.message}`)).toEqual([]);
  });
});
