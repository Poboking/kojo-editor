/**
 * 教程行内标记 + 渲染树（TUT-1）。`tutorial.test.ts` 管"内容对不对"（覆盖面 /
 * 溯源 / 措辞），这里管"标记上不上得了屏"：解析器行为、内容配平守卫、渲染结构
 * （标记真的变成 <strong> / <code>，而不是原样星号——那正是本轮修的 bug）。
 */

import { describe, expect, it } from 'vitest';
import { parseTutorialInline, type TutorialInlineNode } from '../src/tutorial-inline';
import { KOJO_TUTORIAL, SUGAR_TUTORIAL, type Tutorial } from '../src/tutorial-content';
import { createTutorialOverlay } from '../src/tutorial-overlay';

// ---------------------------------------------------------------- 解析器单测

describe('parseTutorialInline：配对、优先级与宽松失败', () => {
  it('纯文本原样返回', () => {
    expect(parseTutorialInline('一句话')).toEqual([{ kind: 'text', text: '一句话' }]);
  });

  it('空串返回空数组', () => {
    expect(parseTutorialInline('')).toEqual([]);
  });

  it('粗体成对', () => {
    expect(parseTutorialInline('a **b** c')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
      { kind: 'text', text: ' c' },
    ]);
  });

  it('行内代码成对', () => {
    expect(parseTutorialInline('写 `时机 初见：` 一行')).toEqual([
      { kind: 'text', text: '写 ' },
      { kind: 'code', text: '时机 初见：' },
      { kind: 'text', text: ' 一行' },
    ]);
  });

  it('粗体内嵌代码：strong 里再出一层 code（内容里的真实形态）', () => {
    expect(parseTutorialInline('**`否则` 必须写**')).toEqual([
      {
        kind: 'strong',
        children: [
          { kind: 'code', text: '否则' },
          { kind: 'text', text: ' 必须写' },
        ],
      },
    ]);
  });

  it('代码优先：反引号里的 ** 是码内字面', () => {
    expect(parseTutorialInline('`a ** b`')).toEqual([{ kind: 'code', text: 'a ** b' }]);
  });

  it('未闭合的 ** 按字面保留，不吞字符', () => {
    expect(parseTutorialInline('a**b')).toEqual([{ kind: 'text', text: 'a**b' }]);
  });

  it('未闭合的反引号按字面保留', () => {
    expect(parseTutorialInline('a`b')).toEqual([{ kind: 'text', text: 'a`b' }]);
  });

  it('码段里的反斜杠就是字面反斜杠（不实现反斜杠转义）', () => {
    expect(parseTutorialInline('反斜杠 `\\` 换行')).toEqual([
      { kind: 'text', text: '反斜杠 ' },
      { kind: 'code', text: '\\' },
      { kind: 'text', text: ' 换行' },
    ]);
  });

  it('多对标记逐对配对，互不嵌套', () => {
    expect(parseTutorialInline('**a** x **b**')).toEqual([
      { kind: 'strong', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'text', text: ' x ' },
      { kind: 'strong', children: [{ kind: 'text', text: 'b' }] },
    ]);
  });
});

// ---------------------------------------------------------------- 内容守卫

const tutorials: [string, Tutorial][] = [
  ['sugar', SUGAR_TUTORIAL],
  ['kojo', KOJO_TUTORIAL],
];

function renderableFields(id: string, t: Tutorial): [string, string][] {
  const out: [string, string][] = [
    [`${id}.title`, t.title],
    [`${id}.lead`, t.lead],
  ];
  t.sections.forEach((s, i) => {
    out.push([`${id}.s${i}.heading`, s.heading]);
    s.paragraphs.forEach((p, j) => out.push([`${id}.s${i}.p${j}`, p]));
    (s.samples ?? []).forEach((sample, j) => {
      if (sample.caption) out.push([`${id}.s${i}.sample${j}.caption`, sample.caption]);
    });
  });
  return out;
}

function* allNodes(nodes: TutorialInlineNode[]): Generator<TutorialInlineNode> {
  for (const n of nodes) {
    yield n;
    if (n.kind === 'strong') yield* allNodes(n.children);
  }
}

describe('教程内容：行内标记配平守卫（抓未来的内容写坏）', () => {
  it('所有可渲染字段解析后零残留星号 / 反引号', () => {
    const hits: string[] = [];
    for (const [id, t] of tutorials) {
      for (const [where, text] of renderableFields(id, t)) {
        for (const node of allNodes(parseTutorialInline(text))) {
          if (node.kind === 'text' && /[*`]/.test(node.text)) {
            hits.push(`${where}: 「${node.text.slice(0, 40)}」`);
          }
        }
      }
    }
    expect(hits, `有标记未配对（会原样上屏）：\n${hits.join('\n')}`).toEqual([]);
  });

  it('两种标记都真的在用（守卫不在零标记内容上自欺）', () => {
    let strong = 0;
    let code = 0;
    for (const [id, t] of tutorials) {
      for (const [, text] of renderableFields(id, t)) {
        for (const node of allNodes(parseTutorialInline(text))) {
          if (node.kind === 'strong') strong++;
          if (node.kind === 'code') code++;
        }
      }
    }
    expect(strong).toBeGreaterThan(20);
    expect(code).toBeGreaterThan(100);
  });

  it('嵌套形（粗体内的代码）至少一处——解析器最易退化的一条路', () => {
    let nested = 0;
    for (const [id, t] of tutorials) {
      for (const [, text] of renderableFields(id, t)) {
        for (const node of allNodes(parseTutorialInline(text))) {
          if (node.kind === 'strong' && node.children.some((c) => c.kind === 'code')) nested++;
        }
      }
    }
    expect(nested).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- 渲染树

interface El {
  type: unknown;
  props: Record<string, unknown>;
}

function walkEls(node: unknown, out: El[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) walkEls(n, out);
    return;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.props !== 'object' || el.props === null) return;
  out.push({ type: el.type, props: el.props });
  walkEls(el.props.children, out);
}

/** 收集子树里的字符串孩子（元素树不是 DOM，直接走 props.children） */
function collectStrings(children: unknown, out: string[] = []): string[] {
  if (typeof children === 'string') out.push(children);
  else if (Array.isArray(children)) for (const c of children) collectStrings(c, out);
  else if (children && typeof children === 'object') {
    const el = children as { props?: Record<string, unknown> };
    if (el.props) collectStrings(el.props.children, out);
  }
  return out;
}

describe('渲染树：标记变元素、样例成对照', () => {
  const treeOf = (t: Tutorial): El[] => {
    const els: El[] = [];
    walkEls(createTutorialOverlay({ tutorial: t, close: () => {} })(), els);
    return els;
  };

  it('strong / code 真的上了屏（记数与内容逐一对账，而不是原样字面）', () => {
    for (const [id, t] of tutorials) {
      let strong = 0;
      let inlineCode = 0;
      for (const [, text] of renderableFields(id, t)) {
        for (const node of allNodes(parseTutorialInline(text))) {
          if (node.kind === 'strong') strong++;
          if (node.kind === 'code') inlineCode++;
        }
      }
      expect(strong).toBeGreaterThan(0);
      const all = t.sections.flatMap((s) => s.samples ?? []);
      const dual = all.filter((s) => s.erb).length;
      const preCount = dual * 2 + (all.length - dual);

      const els = treeOf(t);
      expect(els.filter((e) => e.type === 'strong').length).toBe(strong);
      // 树里的 code = 行内芯片 + 每个样例代码块外层包的那只 code
      expect(els.filter((e) => e.type === 'code').length).toBe(inlineCode + preCount);
    }
  });

  it('段落与样例说明里零残留星号 / 反引号', () => {
    const hits: string[] = [];
    for (const [, t] of tutorials) {
      for (const el of treeOf(t)) {
        if (el.type !== 'p' && el.props.className !== 'tutorial-caption dim') continue;
        for (const s of collectStrings(el.props.children)) {
          if (/[*`]/.test(s)) hits.push(`${String(el.type)} 「${s.slice(0, 40)}」`);
        }
      }
    }
    expect(hits, `文本里仍有标记字面：\n${hits.join('\n')}`).toEqual([]);
  });

  it('带产物的样例左右对照：左 pre / 中「编译为」/ 右 pre，数量与内容一致', () => {
    for (const [, t] of tutorials) {
      const dual = t.sections.flatMap((s) => s.samples ?? []).filter((s) => s.erb).length;
      const pairs = treeOf(t).filter((e) => e.props.className === 'tutorial-pair');
      expect(pairs.length).toBe(dual);
      expect(pairs.length).toBeGreaterThan(0);
      for (const p of pairs) {
        const kids = ([] as unknown[]).concat(p.props.children as unknown);
        expect(kids.length).toBe(3);
        expect((kids[0] as El).type).toBe('pre');
        const arrow = kids[1] as El;
        expect(arrow.props.className).toBe('tutorial-arrow');
        expect(arrow.props.children).toBe('编译为');
        expect((kids[2] as El).type).toBe('pre');
      }
    }
  });

  it('双块样例的 pre 计数 = 双块×2 + 单块×1（单块不进对照）', () => {
    for (const [, t] of tutorials) {
      const all = t.sections.flatMap((s) => s.samples ?? []);
      const dual = all.filter((s) => s.erb).length;
      const preCount = treeOf(t).filter((e) => e.type === 'pre').length;
      expect(preCount).toBe(dual * 2 + (all.length - dual));
    }
  });
});
