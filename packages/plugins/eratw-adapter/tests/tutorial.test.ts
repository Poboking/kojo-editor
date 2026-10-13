/**
 * 内置教程内容与接线单测（E6）。
 *
 * 教程是"会过期的代码"：这里钉的是**结构性底线**（节数、标题唯一、段落/样例非空、
 * 样例不出现 `undefined` 这类拼装泄漏），以及两条必须成立的内容事实——
 * 语法糖教程的样例量与可读性、口上教程的「两真相源」句（工作区 / 游戏目录）。
 * 文风与正确性不靠断言，靠内容模块头注里的溯源纪律。
 */

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
