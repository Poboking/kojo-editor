/**
 * 内置教程内容与接线单测（E6；E10 补「样例溯源守卫」）。
 *
 * 教程是"会过期的代码"：这里钉的是**结构性底线**（节数、标题唯一、段落/样例非空、
 * 样例不出现 `undefined` 这类拼装泄漏），两条必须成立的内容事实——
 * 语法糖教程的样例量与可读性、口上教程的「两真相源」句（工作区 / 游戏目录）——
 * 以及 E10 新增的**样例溯源守卫**：两个教程里的代码样例逐字取自教学样例
 * `fixtures/sugar/teaching-full.kojo` 与它的 `.expected.erb`，只许截取、不许改写。
 * 文风与正确性仍不靠断言，靠内容模块头注里的溯源纪律。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOJO_TUTORIAL, SUGAR_TUTORIAL, TUTORIALS } from '../src/tutorial-content';
import {
  KOJO_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
  createTutorialOverlay,
} from '../src/tutorial-overlay';

describe('教程内容（E6）', () => {
  it('两个教程 id / title 正确，且 TUTORIALS 索引与单例一致', () => {
    expect(TUTORIALS.sugar).toBe(SUGAR_TUTORIAL);
    expect(TUTORIALS.kojo).toBe(KOJO_TUTORIAL);
    expect(SUGAR_TUTORIAL.id).toBe('sugar');
    expect(KOJO_TUTORIAL.id).toBe('kojo');
    expect(SUGAR_TUTORIAL.title).toBe('语法糖教程');
    expect(KOJO_TUTORIAL.title).toBe('口上教程');
    expect(SUGAR_TUTORIAL.lead.length).toBeGreaterThan(0);
    expect(KOJO_TUTORIAL.lead.length).toBeGreaterThan(0);
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：节数 ≥ 6，标题非空且互不重复', (t) => {
    expect(t.sections.length).toBeGreaterThanOrEqual(6);
    const headings = t.sections.map((s) => s.heading);
    for (const h of headings) expect(h.trim().length).toBeGreaterThan(0);
    expect(new Set(headings).size).toBe(headings.length);
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每节段落非空、样例给定字段合法', (t) => {
    for (const s of t.sections) {
      expect(s.paragraphs.length).toBeGreaterThan(0);
      for (const p of s.paragraphs) expect(p.trim().length).toBeGreaterThan(0);
      for (const sample of s.samples ?? []) {
        expect(sample.kojo.trim().length).toBeGreaterThan(0);
        expect(sample.kojo).not.toContain('undefined');
        if (sample.erb !== undefined) {
          expect(sample.erb.trim().length).toBeGreaterThan(0);
          expect(sample.erb).not.toContain('undefined');
        }
      }
    }
  });

  it('语法糖教程：样例 ≥ 6（每种写法都要有对照实例）', () => {
    const samples = SUGAR_TUTORIAL.sections.flatMap((s) => s.samples ?? []);
    expect(samples.length).toBeGreaterThanOrEqual(6);
    for (const sample of samples) expect(sample.kojo.trim().length).toBeGreaterThan(0);
  });

  it('口上教程：至少一节同时讲「工作区」与「游戏目录」（两真相源句）', () => {
    const hit = KOJO_TUTORIAL.sections.some((s) => {
      const text = [s.heading, ...s.paragraphs].join('\n');
      return text.includes('工作区') && text.includes('游戏目录');
    });
    expect(hit).toBe(true);
  });
});

/**
 * 教程样例的**溯源守卫**（E10）。
 *
 * 纪律：两个教程里的代码样例逐字取自 `fixtures/sugar/teaching-full.kojo` 与
 * `fixtures/sugar/teaching-full.expected.erb`（语法糖教程的每一种写法、口上教程
 * 的每个代码片段都来自那里），只允许截取、不允许改写。这里用最朴素的方式守住它：
 * 把样例按行拆开，每行去掉行首空白后，检查它在教学样例里出现过。
 *
 * 这是**宽松**守卫，宽松之处都是故意的：
 * - 只查"这一行存在"，不查"来自哪一段"——允许把 fixture 里不同位置的整行拼成一个
 *   样例（教程需要把"文件头"和"某一块"放在一起讲）；
 * - 行首空白一律忽略——截取时会剥掉整块缩进（tab 与 4 空格互换不算漂移）。
 * 它的目的不是证明内容正确，而是抓"日后有人手滑改了样例里的一个字"。
 */
const KOJO_FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/sugar/teaching-full.kojo', import.meta.url),
);
const ERB_FIXTURE_PATH = fileURLToPath(
  new URL('../../../../fixtures/sugar/teaching-full.expected.erb', import.meta.url),
);

/** 读一份教学样例并按行归一：去 BOM、统一换行、去行首空白、丢空行 */
function fixtureLineSet(path: string): Set<string> {
  return new Set(
    readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trimStart())
      .filter((line) => line.length > 0),
  );
}

/** 样例里所有"在 fixture 中找不到"的行（空数组 = 逐字对得上） */
function driftedLines(sample: string, allowed: Set<string>): string[] {
  return sample
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0 && !allowed.has(line));
}

describe('教程样例溯源守卫（E10，宽松口径）', () => {
  const kojoLines = fixtureLineSet(KOJO_FIXTURE_PATH);
  const erbLines = fixtureLineSet(ERB_FIXTURE_PATH);

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每条 kojo 样例行都能在教学样例里逐字找到', (t) => {
    const drift: string[] = [];
    for (const s of t.sections) {
      for (const sample of s.samples ?? []) {
        for (const line of driftedLines(sample.kojo, kojoLines)) drift.push(`${s.heading} → ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每条 erb 样例行都能在教学样例的产物里逐字找到', (t) => {
    const drift: string[] = [];
    for (const s of t.sections) {
      for (const sample of s.samples ?? []) {
        if (sample.erb === undefined) continue;
        for (const line of driftedLines(sample.erb, erbLines)) drift.push(`${s.heading} → ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it('守卫自身是有效的（每个改字都能抓到，且有真实命中）', () => {
    // 正样本：样例里真实存在的行（含「去掉公共缩进」的写法）必须通过
    expect(driftedLines('    「……嗯？是谁？」', kojoLines)).toEqual([]);
    expect(driftedLines('「……嗯？是谁？」', kojoLines)).toEqual([]);
    // 负样本：改一个字就必须被抓出，防止守卫退化成"永远通过"
    expect(driftedLines('    「……嗯？是谁！」', kojoLines)).not.toEqual([]);
    expect(driftedLines('PRINTFORMW 「……嗯？是谁！」', erbLines)).not.toEqual([]);
  });
});

describe('教程浮层接线（E6）', () => {
  it('overlay id 命名与既有向导对齐（eratw. 前缀 + 教程名）', () => {
    expect(SUGAR_TUTORIAL_OVERLAY_ID).toBe('eratw.tutorialSugar');
    expect(KOJO_TUTORIAL_OVERLAY_ID).toBe('eratw.tutorialKojo');
  });

  it('工厂产出宿主可渲染的组件（UIPanelComponent 形态）', () => {
    for (const tutorial of [SUGAR_TUTORIAL, KOJO_TUTORIAL]) {
      expect(typeof createTutorialOverlay({ tutorial, close: () => {} })).toBe('function');
    }
  });
});
