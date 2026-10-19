/**
 * E1 格式化核心的**不变量**验收：对仓库里每一份真实 `.kojo`（goldens + fixtures）逐条自证
 * "格式化只改写法、不改语义"。
 *
 * 为什么不是逐字节断言产物而是断言"改前 == 改后"：产物由 codegen 决定，源码缩进一改
 * 就得同步一堆期望文件；而真正要钉住的是**这次改动什么都没改变**——
 * ① 每行的缩进层级逐行相等（转译器口径，即 `indentLevel`），
 * ② 转译产物逐字节相等，
 * ③ 诊断（码 + 严重度 + 行号）逐条相等 ⇒ 结构错误不被"顺手修掉"，也不被改坏。
 *
 * 顺带自证幂等（第二轮零改动）与行尾逐条不变。
 *
 * **ERB 形半边**（本批新增）：取样面 = 仓库全部 `.ERB/.erb`（goldens 翻译样张是语料派生的
 * 真 ERB 形）+ 钉住合成小样（形态取自基线语料实测，见该组头注；不含语料真实文本）。
 * 钉两件事：①格式化幂等（第二轮零改动）；②**数据表块体与停用死区逐字节不变**——
 * 判据取 `formatter.ts` 的 `erbBodyLineMask` 本体（同一真源，测试不抄第二份状态机）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { computeFormatEdits, erbBodyLineMask, erbBodyRegionAtLineEnd, erbBodyRegions, formatText } from '../src/formatter';
import { splitLogicalLines } from '../src/lexer';
import { createSugarTranspileService } from '../src/service';
import { stubDict, stubFaceTable } from './support';

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

/** 仓库自带的 `.kojo` 样例（不依赖外部语料目录；语料不在位也照样跑） */
function sampleKojo(): { name: string; text: string }[] {
  const dirs = [
    path.join(ROOT, 'packages', 'plugins', 'kojo-sugar', 'tests', 'goldens'),
    path.join(ROOT, 'fixtures', 'sugar'),
    path.join(ROOT, 'fixtures', 'scaffold'),
  ];
  const out: { name: string; text: string }[] = [];
  for (const d of dirs) {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.kojo')) continue;
      const f = path.join(d, e.name);
      out.push({ name: `${path.basename(d)}/${e.name}`, text: readFileSync(f, 'utf8') });
    }
  }
  return out;
}

const service = () => createSugarTranspileService({ dictionary: stubDict, faceTable: stubFaceTable() });

/** 诊断的可比较形状（码 / 严重度 / 源行；`loc` 是位置不是区间） */
const diagShape = (source: string) =>
  service()
    .transpile(source)
    .diagnostics.map((d) => `${d.code}|${d.severity}|${d.loc?.line ?? '-'}`);

const levels = (source: string) => splitLogicalLines(source).map((l) => `${l.line}:${l.indent}`);

const eols = (source: string) => [...source.matchAll(/\r\n|\r|\n/g)].map((m) => m[0]);

/** 逐行把空白串折成单个空格并去首尾 —— "产物只许有空白之差"的比较形状 */
const squash = (source: string) =>
  source
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n');

describe('真实 `.kojo` 样例：格式化不改语义', () => {
  const samples = sampleKojo();

  it('样例面不为空（护栏别在空目录上自欺）', () => {
    expect(samples.length).toBeGreaterThanOrEqual(8);
  });

  for (const s of samples) {
    it(`${s.name}：层级 / 产物 / 诊断 / 行尾全部不变，且幂等`, () => {
      const { text: out, edits } = formatText(s.text, 'kojo');
      expect(eols(out), '行尾序列必须逐条不变').toEqual(eols(s.text));
      expect(levels(out), '每行缩进层级必须逐行相等').toEqual(levels(s.text));
      const erbOut = service().transpile(out).erb;
      const erbSrc = service().transpile(s.text).erb;
      expect(squash(erbOut), '产物只许有空白之差').toBe(squash(erbSrc));
      // 源里没有全角空格 ⇒ 连"注释里的折算"这一类空白差也不该有 ⇒ 逐字节相等
      if (!s.text.includes(FULLWIDTH_SPACE)) expect(erbOut).toBe(erbSrc);
      expect(diagShape(out)).toEqual(diagShape(s.text));
      expect(computeFormatEdits(out, 'kojo'), '第二轮应当零改动').toEqual([]);
      expect(edits.every((e) => !e.text.includes('\n') && !e.text.includes('\r'))).toBe(true);
    });
  }
});

/** 把糖行的行首空白换写成 TAB（层级不变）——用来给"缩进归一"这条规则造真实改写 */
function retab(text: string): string {
  const lines = text.split('\n');
  for (const l of splitLogicalLines(text)) {
    if (l.indent === 0) continue;
    const idx = l.line - 1;
    const content = lines[idx];
    if (content === undefined || !content.startsWith(l.rawIndent)) continue;
    lines[idx] = '\t'.repeat(l.indent) + content.slice(l.rawIndent.length);
  }
  return lines.join('\n');
}

describe('真实 `.kojo` 样例：规则本身有牙', () => {
  const samples = sampleKojo();
  // 只挑"没有 `@` 原生块"的样例：块内逐行进产物，换写它不属于本规则的职责
  const plain = samples.filter((s) => !s.text.includes(FULLWIDTH_SPACE) && !/^\s*@/m.test(s.text));

  it('样例面里确有被改写的（否则上面的不变量全是恒真）', () => {
    expect(samples.filter((s) => formatText(s.text, 'kojo').edits.length > 0).length).toBeGreaterThan(0);
  });

  it('把无全角的样例缩进换写成 TAB：层级不变、产物逐字节不变、且格式化后幂等', () => {
    expect(plain.length).toBeGreaterThan(0);
    let rewritten = 0;
    for (const s of plain) {
      const perturbed = retab(s.text);
      if (perturbed === s.text) continue; // 本来就是 TAB ⇒ 没改写成功，不计入
      rewritten++;
      const out = formatText(perturbed, 'kojo').text;
      expect(levels(out), s.name).toEqual(levels(s.text));
      expect(service().transpile(out).erb, s.name).toBe(service().transpile(s.text).erb);
      expect(computeFormatEdits(out, 'kojo'), s.name).toEqual([]);
    }
    expect(rewritten).toBeGreaterThan(0);
  });
});

describe('结构错误不由格式化负责（与 `erb-structure-fix` 划界）', () => {
  /** 缩进不齐的合法-ish 文档：块体没缩进到位 ⇒ 转译报 `indent-mismatch` */
  const broken = ['角色: 12', '时机 指令 310：', '「甲。」', '  如果 1 = 1：', '      「乙。」'].join('\n');

  it('格式化前后诊断逐条相同（不"顺手补"结构，也不新增结构诊断）', () => {
    expect(diagShape(broken).length).toBeGreaterThan(0);
    const out = formatText(broken, 'kojo').text;
    expect(diagShape(out)).toEqual(diagShape(broken));
  });

  it('产物里不会因为格式化多出 ENDIF 一族（补 ENDIF 是 quick fix 的活）', () => {
    const out = formatText(broken, 'kojo').text;
    expect(squash(service().transpile(out).erb)).toBe(squash(service().transpile(broken).erb));
    expect(out).not.toMatch(/^ENDIF/m);
    expect(out).not.toMatch(/^如果/m);
  });
});

describe('保层级的单位换算（`indentLevel` 的硬约束）', () => {
  it('4 空格文件整体折成 TAB：层级不变 ⇒ 产物逐字节不变，且 TAB 版已是规范写法（零改动）', () => {
    const src = ['角色: 12', '时机 指令 310：', '    「呀。」', '    如果 1 = 1：', '        「嗯。」'].join('\n');
    const tabs = src.replace(/^ {8}/gm, '\t\t').replace(/^ {4}/gm, '\t');
    // 前提自证：这份"手工 TAB 版"确实与原文逐行同层级
    expect(levels(tabs)).toEqual(levels(src));
    expect(service().transpile(tabs).erb).toBe(service().transpile(src).erb);
    // 主体是 TAB ⇒ 单位探测取 TAB，归一结果就是它本身（不把它拉回 4 空格）
    expect(computeFormatEdits(tabs, 'kojo')).toEqual([]);
  });

  it('台词正文里的 U+3000 在真实样例上也一个不动', () => {
    const src = ['角色: 12', '时机 指令 310：', '「呀。」　嗯', `;　分隔${'	'}注释`].join('\n');
    const out = formatText(src, 'kojo').text;
    expect(out.split('\n')[2]).toBe('「呀。」　嗯');
    expect(out.split('\n')[3]).toBe('; 分隔\t注释');
  });
});

/* ============================== ERB 形：块上下文闸（本批新增） ============================== */

/** 仓库自带的 `.ERB/.erb` 样张（goldens 是语料派生的真 ERB；mini-game 递归收） */
function sampleErb(): { name: string; text: string }[] {
  const dirs = [
    [path.join(ROOT, 'packages', 'plugins', 'kojo-sugar', 'tests', 'goldens'), false],
    [path.join(ROOT, 'fixtures', 'sugar'), false],
    [path.join(ROOT, 'fixtures', 'scaffold'), false],
    [path.join(ROOT, 'fixtures', 'mini-game'), true],
  ] as const;
  const out: { name: string; text: string }[] = [];
  const walk = (d: string, recursive: boolean): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (recursive) walk(f, true);
      } else if (e.isFile() && /\.erb$/i.test(e.name)) {
        out.push({ name: path.relative(ROOT, f), text: readFileSync(f, 'utf8') });
      }
    }
  };
  for (const [d, rec] of dirs) walk(d, rec);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 物理行拆分（与 `formatter.ts` 的 `splitPhysical` 同判据；这里只取内容） */
const erbLines = (text: string): string[] => text.split(/\r\n|\r|\n/);

describe('真实 ERB 样张：块体/死区字节不变、幂等、行尾不变', () => {
  const samples = sampleErb();

  it('取样面非空，且确有块体行与区外改写（护栏别在空面上自欺）', () => {
    expect(samples.length).toBeGreaterThanOrEqual(12);
    let protectedLines = 0;
    let outsideEdits = 0;
    for (const s of samples) {
      protectedLines += erbBodyLineMask(erbLines(s.text)).filter(Boolean).length;
      outsideEdits += computeFormatEdits(s.text, 'erb').length;
    }
    // 实测面：15 个文件、保护区 139 行（goldens 的 daily/event 翻译样张是大头）、区外编辑 19 条
    expect(protectedLines).toBeGreaterThanOrEqual(100);
    expect(outsideEdits).toBeGreaterThan(0);
  });

  for (const s of samples) {
    it(`${s.name}：块体逐字节不动、区外规则照常、第二轮零改动`, () => {
      const before = erbLines(s.text);
      const mask = erbBodyLineMask(before);
      const out = formatText(s.text, 'erb').text;
      const after = erbLines(out);
      expect(after.length, '行数不许变（edit 永不跨行）').toBe(before.length);
      for (let i = 0; i < before.length; i++) {
        if (mask[i]) expect(after[i], `第 ${i + 1} 行是数据表块体/停用死区，一个字节都不许动`).toBe(before[i]);
      }
      expect(eols(out), '行尾序列必须逐条不变').toEqual(eols(s.text));
      expect(computeFormatEdits(out, 'erb'), '第二轮应当零改动（幂等）').toEqual([]);
    });
  }
});

describe('ERB 块体/死区钉住小样（合成等价形态，判据全覆盖）', () => {
  /**
   * 来源：合成等价形态，**不含语料真实文本**；每一枚行形态都有基线盘实测出处
   * （3,818 个 `.ERB` / 4,115,008 行：数据表 3,874 块 / 块体 29,518 行——开词裸形 3,576、
   * 带尾形 298（`PRINTDATAL LOCAL` / `STRDATA 台词`），条目 `DATA`/`DATAFORM` 20,132 行；
   * 停用区 2,186 对 / 区内 95,616 行。今天逐行规则改动 19,975 行，其中 **1,290 行落在区内**：
   * 死区全角缩进折半 103、区内注释折算 151、区内纯空白清空 1,036。本小样把这四类伤害形态
   * **逐类钉死**（代表的是判据覆盖面，不是语料的行数分数）。
   */
  const FW = FULLWIDTH_SPACE;
  const blockSrc = [
    `${FW}PRINTL 区外缩进要折`, //   1 区外：折（teeth）
    `;　区外注释要折`, //           2 区外：折（teeth）
    'PRINTDATA', //                   3 开词=结构行
    `${FW}${FW}DATA ${FW}表体行不许动`, //      4 块体：缩进+参数逐字节钉
    '    ', //                        5 块体：纯空白行不清空
    `;　块体注释不许折`, //                  6 块体：注释折算也不做
    'DATALIST', //                    7 分组记号：同属块体（判不准就不动）
    `${FW}DATAFORM ${FW}分组内不许动`, //       8 块体
    'ENDLIST', //                     9 块体
    'ENDDATA', //                     10 收束=结构行
    'STRDATA 台词', //                11 第二族开词（带尾形，结构行）
    `${FW}DATAFORM ${FW}串表体不许动`, //       12 块体
    'ENDDATA', //                     13 收束
    `;　停用标记的引用形不是区首`, //          14 区外注释：折（teeth；含 `[SKIPSTART]` 字样的注释不误开区）
    ';[SKIPSTART]', //                15 区外注释、非标记（不折：无全角）
    '[SKIPSTART]', //                 16 死区首=结构行
    `${FW}散文式自注释不许动`, //              17 死区正文：全角缩进不折（盘上 103 行同类）
    '   ', //                         18 死区纯空白：不清空（盘上 1,036 行同类）
    `;　死区注释不许折`, //                  19 死区注释：不折（盘上 151 行同类）
    '[SKIPEND]', //                   20 死区尾=结构行
    `${FW}PRINTL 出区后继续折`, //             21 区外：折（teeth）
  ].join('\n');

  it('块体/死区行零编辑，区外三类规则照常生效，且幂等', () => {
    const before = erbLines(blockSrc);
    const mask = erbBodyLineMask(before);
    const inBody = [4, 5, 6, 7, 8, 9, 12, 17, 18, 19].map((n) => n - 1);
    for (const i of inBody) expect(mask[i], `第 ${i + 1} 行必须判为块体/死区`).toBe(true);
    for (const i of [2, 9, 10, 15, 19]) expect(mask[i], `第 ${i + 1} 行是结构行，不该判为体`).toBe(false);

    const { text: out, edits } = formatText(blockSrc, 'erb');
    // 伤害面回退即红：块体/死区逐字节比对
    const after = erbLines(out);
    for (let i = 0; i < before.length; i++) {
      if (mask[i]) expect(after[i], `第 ${i + 1} 行被动过`).toBe(before[i]);
    }
    expect(edits.map((e) => e.line), '区外只该动这四行').toEqual([1, 2, 14, 21]);
    expect(edits.map((e) => e.text)).toEqual([
      '  PRINTL 区外缩进要折',
      '; 区外注释要折',
      '; 停用标记的引用形不是区首',
      '  PRINTL 出区后继续折',
    ]);
    expect(computeFormatEdits(out, 'erb'), '第二轮应当零改动').toEqual([]);
  });

  it('未收束的开词：其后整段按块体保守不动（判不准就不动的口径）', () => {
    const src = ['@FUNCTION 甲', 'PRINTDATA', `${FW}DATA ${FW}未收束也不动`, '   '].join('\n');
    expect(formatText(src, 'erb').text).toBe(src);
    expect(computeFormatEdits(src, 'erb')).toEqual([]);
  });

  it('掩码语义单点自证：结构行不算体、停用区优先于数据表', () => {
    expect(erbBodyLineMask(['PRINTDATA', 'DATA 甲', 'ENDDATA', 'DATA 游离在区外'])).toEqual([
      false, true, false, false,
    ]);
    // 停用区优先：区内的 PRINTDATA/ENDDATA 都是正文，不推动数据表深度
    expect(erbBodyLineMask(['[SKIPSTART]', 'PRINTDATA', 'ENDDATA', '[SKIPEND]', 'DATA x'])).toEqual([
      false, true, true, false, false,
    ]);
    // 数据表内的嵌套开词：深度计到配对收束；两枚 `ENDDATA` 各归其块、都是结构行
    expect(erbBodyLineMask(['PRINTDATA', 'PRINTDATA', 'DATA 甲', 'ENDDATA', 'DATA 乙', 'ENDDATA', 'PRINTL 出块'])).toEqual([
      false, true, true, false, true, false, false,
    ]);
  });
});

/* ============ 块状态机的**另两种投影**（区段清单 / 末态）：窗口取文腿的前推锚点判据 ============ */

describe('ERB 块状态机的区段投影与末态（erbBodyRegions / erbBodyRegionAtLineEnd）', () => {
  it('区段投影与掩码投影出自同一趟扫描（逐行等价，且区段首尾都是"被保护行"）', () => {
    const lines = [
      'PRINTL 区外', 'PRINTDATA', 'DATA 甲', 'ENDDATA', 'ENDDATA',
      '[SKIPSTART]', '散文', '   ', '[SKIPEND]', 'PRINTL 又区外',
    ];
    const mask = erbBodyLineMask(lines);
    const regions = erbBodyRegions(lines);
    const projected = new Array<boolean>(lines.length).fill(false);
    for (const r of regions) for (let i = r.start; i <= r.end; i++) projected[i] = true;
    expect(projected).toEqual(mask);
    expect(regions).toEqual([
      { kind: 'data', open: 1, start: 2, end: 2 },
      { kind: 'skip', open: 5, start: 6, end: 7 },
    ]);
  });

  it('末态说"还在区里"时给的是**最外层**区首（嵌套里层收束之后仍然如此）', () => {
    const lines = ['PRINTDATA', 'DATA 甲', 'PRINTDATA', 'DATA 乙', 'ENDDATA', 'DATA 丙', 'ENDDATA'];
    // 掩码在第 5 行（深度 2→1 的那枚收束）判假——末态判据**不能**拿末行掩码代替
    expect(erbBodyLineMask(lines.slice(0, 5))[4]).toBe(false);
    expect(erbBodyRegionAtLineEnd(lines.slice(0, 5).join('\n'))).toEqual({ kind: 'data', openLine: 1 });
    // 配对收束之后才真的出区
    expect(erbBodyRegionAtLineEnd(lines.slice(0, 6).join('\n'))).toEqual({ kind: 'data', openLine: 1 });
    expect(erbBodyRegionAtLineEnd(lines.slice(0, 7).join('\n'))).toBeNull();
  });

  it('停用区优先：死区里的 `PRINTDATA` 不推动深度，末态仍是 skip 族', () => {
    const lines = ['[SKIPSTART]', 'PRINTDATA', 'DATA 甲'];
    expect(erbBodyRegionAtLineEnd(lines.join('\n'))).toEqual({ kind: 'skip', openLine: 1 });
    expect(erbBodyRegionAtLineEnd(lines.slice(0, 2).join('\n'))).toEqual({ kind: 'skip', openLine: 1 });
  });

  it('未收束到文件尾 ⇒ 末态仍在区里（保守：其后全按块体）', () => {
    expect(erbBodyRegionAtLineEnd('@FUNCTION 甲\nPRINTDATA\nDATA 乙')).toEqual({ kind: 'data', openLine: 2 });
    expect(erbBodyRegionAtLineEnd('[SKIPSTART]\n散文')).toEqual({ kind: 'skip', openLine: 1 });
  });

  it('区外末态返回 `null`（窗口腿据此免检；含"空文本"与"游离收束"两种边界）', () => {
    expect(erbBodyRegionAtLineEnd('')).toBeNull();
    expect(erbBodyRegionAtLineEnd('PRINTL 甲\nENDDATA')).toBeNull(); // 游离收束不开区，也不改变末态
    // 开词行自己是结构行，**但末态已经在区里**：紧跟其后的那一行就是块体 ⇒ 窗口腿必须前推到它
    expect(erbBodyRegionAtLineEnd('PRINTDATA')).toEqual({ kind: 'data', openLine: 1 });
    expect(erbBodyRegionAtLineEnd('PRINTDATA\nDATA 甲\nENDDATA')).toBeNull();
  });

  it('预筛与判据同口径：各种行首空白与带尾形态都照旧认得（预筛只可能放过，不可能认错）', () => {
    for (const lead of [' ', '\t', `${FULLWIDTH_SPACE}${FULLWIDTH_SPACE}`, '\u00a0', '\u2003']) {
      const lines = [`${lead}PRINTDATA`, `${lead}DATA 甲`, `${lead}ENDDATA`];
      expect(erbBodyLineMask(lines), `行首 ${JSON.stringify(lead)} 的块体必须挨保护`).toEqual([false, true, false]);
      expect(erbBodyRegionAtLineEnd(lines.slice(0, 2).join('\n')), `行首 ${JSON.stringify(lead)} 的末态必须在区里`).toEqual({
        kind: 'data',
        openLine: 1,
      });
    }
    // 大小写与带别名一概不认（与 `erb-parser/scanner.ts` 的严格等值口径一致）
    expect(erbBodyLineMask(['printdata', 'DATA 甲'])).toEqual([false, false]);
    expect(erbBodyRegionAtLineEnd('printdata\nDATA 甲')).toBeNull();
    expect(erbBodyLineMask(['[skipstart]', 'DATA 甲'])).toEqual([false, false]);
    // 行中出现不等于行首：`X = PRINTDATA` 不是开词
    expect(erbBodyRegionAtLineEnd('CALL PRINTDATA\nDATA 甲')).toBeNull();
  });
});

