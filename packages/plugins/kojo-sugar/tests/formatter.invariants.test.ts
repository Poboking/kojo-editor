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
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FULLWIDTH_SPACE } from '@kojo/plugin-api';
import { computeFormatEdits, formatText } from '../src/formatter';
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
