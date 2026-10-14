/**
 * 内置教程内容与接线单测（E6；E10 补「样例溯源守卫」；E12 守卫来源扩到三份 fixture）。
 *
 * 教程是"会过期的代码"：这里钉的是**结构性底线**（节数、标题唯一、段落/样例非空、
 * 样例不出现 `undefined` 这类拼装泄漏），三条必须成立的内容事实——
 * 语法糖教程的样例量与覆盖面（含选项块、中文运算符、指令中文名查表、自定指令）、
 * 口上教程的「两真相源」句（工作区 / 游戏目录）、以及**已封存功能一律不提**——
 * 以及**样例溯源守卫**：两个教程里的代码样例逐字取自 fixtures（只许截取、不许改写）。
 * 文风（傲娇大小姐口吻、句子长短）不靠断言，靠内容模块头注里的口径纪律。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KOJO_TUTORIAL, SUGAR_TUTORIAL, TUTORIALS, type Tutorial } from '../src/tutorial-content';
import {
  KOJO_TUTORIAL_OVERLAY_ID,
  SUGAR_TUTORIAL_OVERLAY_ID,
  createTutorialOverlay,
} from '../src/tutorial-overlay';

/** 一份教程的全部**叙述**文本（标题、导语、节标题、段落、样例说明；不含代码样例） */
function tutorialText(t: Tutorial): string {
  return [
    t.title,
    t.lead,
    ...t.sections.flatMap((s) => [
      s.heading,
      ...s.paragraphs,
      ...(s.samples ?? []).map((sample) => sample.caption ?? ''),
    ]),
  ].join('\n');
}

describe('教程内容（E6）', () => {
  it('两个教程 id / title 正确，且 TUTORIALS 索引与单例一致', () => {
    expect(TUTORIALS.sugar).toBe(SUGAR_TUTORIAL);
    expect(TUTORIALS.kojo).toBe(KOJO_TUTORIAL);
    expect(SUGAR_TUTORIAL.id).toBe('sugar');
    expect(KOJO_TUTORIAL.id).toBe('kojo');
    expect(SUGAR_TUTORIAL.title).toBe('.kojo 语言教程');
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

  it('.kojo 语言教程：样例 ≥ 24（每种写法都要有对照实例；E12 覆盖面重校后的底线）', () => {
    const samples = SUGAR_TUTORIAL.sections.flatMap((s) => s.samples ?? []);
    expect(samples.length).toBeGreaterThanOrEqual(24);
    for (const sample of samples) expect(sample.kojo.trim().length).toBeGreaterThan(0);
  });

  /**
   * 覆盖面底线（E12）：教程声称"每种写法都摊开"，那这几样现行实现里的写法就必须在场。
   * 钉**出现**而不是钉表述——表述归文风纪律管，漏了某项能力才是这里要抓的。
   */
  it('.kojo 语言教程覆盖现行实现的全部写法面（含 HK-11 查表与 HK-12 五钩子）', () => {
    const text = tutorialText(SUGAR_TUTORIAL);
    for (const surface of [
      '选项', // §3.7 选项块
      '自定指令', // HK-12 五钩子
      '可否使用', // HK-12 可选钩子
      'Train.csv', // HK-11② 指令中文名查表（数据源口径）
      '至少', // §4.3 中文运算符
      '隐藏情景', // §3.2 时机内子句
      '别名', // §3.1 / §3.8
      '空行', // §3.3 v1.4
    ]) {
      expect(text, `.kojo 语言教程漏了写法面：${surface}`).toContain(surface);
    }
  });

  /**
   * 已封存的三件不许出现在教程里（用户 2026-10-13 令：只留设置页一个总开关）。
   * 教程是给零基础作者的第一个信息源，提一件"其实看不见"的功能等于埋一个坑。
   */
  it('两个教程都不提已封存的三件（.kojo 预览 / .kojo 转译检查 / 归档浏览器）', () => {
    const all = tutorialText(SUGAR_TUTORIAL) + tutorialText(KOJO_TUTORIAL);
    for (const sealed of ['.kojo 预览', '.kojo 转译检查', '归档浏览器', '糖视图', '语法糖视图', '糖预览']) {
      expect(all, `教程里出现了已封存功能：${sealed}`).not.toContain(sealed);
    }
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
 * 教程样例的**溯源守卫**（E10；E12 来源扩到三份 fixture）。
 *
 * 纪律：两个教程里的代码样例逐字取自 fixtures，只允许截取、不允许改写。允许的出处
 * 就是仓库里那几份有转译验证的样例文件：
 * - `.kojo` 侧：`teaching-full.kojo`（露米娅 12 号 · 教学）、`release-check.kojo`
 *   （145 号 · 全语法面长跑）、`sample-310.kojo`（规范 §6.1 形态）；
 * - `.ERB` 侧：前两份的 `.expected.erb`（`sample-310` 没有 golden，所以它的行只许
 *   出现在源文一侧）。
 * 这里用最朴素的方式守住它：把样例按行拆开，每行去掉行首空白后，检查它在上面任意一份
 * 出处里出现过。
 *
 * 这是**宽松**守卫，宽松之处都是故意的：
 * - 只查"这一行存在"，不查"来自哪一段、哪一份"——允许把不同位置的整行拼成一个样例
 *   （教程需要把"文件头"和"某一块"放在一起讲，也需要把两份样例的同一面并排给看）；
 * - 行首空白一律忽略——截取时会剥掉整块缩进（tab 与 4 空格互换不算漂移）。
 * 它的目的不是证明内容正确，而是抓"日后有人手滑改了样例里的一个字"。
 */
const sugarFixture = (name: string): string =>
  fileURLToPath(new URL(`../../../../fixtures/sugar/${name}`, import.meta.url));

/** `.kojo` 侧允许的全部出处 */
const KOJO_FIXTURE_PATHS = ['teaching-full.kojo', 'release-check.kojo', 'sample-310.kojo'].map(sugarFixture);
/** `.ERB` 侧允许的全部出处（只含有 golden 的那两份） */
const ERB_FIXTURE_PATHS = ['teaching-full.expected.erb', 'release-check.expected.erb'].map(sugarFixture);

/** 读若干份样例并按行归一后并成一集：去 BOM、统一换行、去行首空白、丢空行 */
function fixtureLineSet(paths: string[]): Set<string> {
  const lines = new Set<string>();
  for (const path of paths) {
    for (const line of readFileSync(path, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((raw) => raw.trimStart())
      .filter((raw) => raw.length > 0)) {
      lines.add(line);
    }
  }
  return lines;
}

/** 样例里所有"在 fixture 中找不到"的行（空数组 = 逐字对得上） */
function driftedLines(sample: string, allowed: Set<string>): string[] {
  return sample
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => line.length > 0 && !allowed.has(line));
}

describe('教程样例溯源守卫（E10 立、E12 扩来源，宽松口径）', () => {
  const kojoLines = fixtureLineSet(KOJO_FIXTURE_PATHS);
  const erbLines = fixtureLineSet(ERB_FIXTURE_PATHS);

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每条 kojo 样例行都能在允许的 .kojo 出处里逐字找到', (t) => {
    const drift: string[] = [];
    for (const s of t.sections) {
      for (const sample of s.samples ?? []) {
        for (const line of driftedLines(sample.kojo, kojoLines)) drift.push(`${s.heading} → ${line}`);
      }
    }
    expect(drift).toEqual([]);
  });

  it.each([SUGAR_TUTORIAL, KOJO_TUTORIAL])('$title：每条 erb 样例行都能在 .ERB golden 里逐字找到', (t) => {
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
    // E12 新接进来的两份出处也必须真的被读进集合（不是"路径写了但没并进来"）
    expect(driftedLines('「要不要赛点钱？」', kojoLines)).toEqual([]); // release-check.kojo
    expect(driftedLines('自定指令 赛钱 可否使用: 她的好感度 至少 50 计数器不发: 她的好感度 至少 90：', kojoLines)).toEqual(
      [],
    ); // release-check.kojo
    expect(driftedLines('    {她的胆怯 ? "眼眶里浮起一点泪光。" : ""}', kojoLines)).toEqual([]); // sample-310.kojo
    expect(driftedLines('INPUTS', erbLines)).toEqual([]); // release-check.expected.erb
    expect(driftedLines('@KOJO_发版检查_COM_NAME_K145_270', erbLines)).toEqual([]); // 同上
    // 负样本：改一个字就必须被抓出，防止守卫退化成"永远通过"
    expect(driftedLines('    「……嗯？是谁！」', kojoLines)).not.toEqual([]);
    expect(driftedLines('PRINTFORMW 「……嗯？是谁！」', erbLines)).not.toEqual([]);
    expect(driftedLines('自定指令 赛钱 可否使用: 她的好感度 至少 51', kojoLines)).not.toEqual([]);
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
