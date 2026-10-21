import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import { capturesToTokenSpans, type Kojo2Capture } from '../src/monaco/tree-sitter/kojo2-tokenizer';
import {
  disposeKojo2TreeSitterRuntime,
  getKojo2TreeSitterRuntime,
  KOJO2_RUNTIME_TIMEOUT_MS,
  type Kojo2RuntimeDeps,
  type Kojo2TreeSitterModule,
  type Kojo2TreeSitterRuntime,
} from '../src/monaco/tree-sitter/kojo2-runtime';

/**
 * Kojo 2.0 tree-sitter 运行时的闸（K2-TS-RUNTIME）。
 *
 * 钉五件事：
 *  1. 单例幂等：并发调用共享同一条 Promise / 同一个运行时；
 *  2. 真 wasm + 真语法能解 2.0 夹具（不 mock 解析器，读仓内 wasm，不联网）；
 *  3. 增量 reparse 与整篇 reparse **结构逐节点等价**（连续多步编辑，含块头边界）；
 *  4. 失败面可判别、不抛：wasm 缺失 / 装载超时 / 非法输入 / 已 dispose；
 *  5. capture→区间映射是纯函数，越界/重叠/跨行拆段都不崩。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/app/tests → 仓库根 */
const REPO_ROOT = resolve(HERE, '../../..');
const RUNTIME_WASM = join(REPO_ROOT, 'node_modules/web-tree-sitter/web-tree-sitter.wasm');
const SYNTAX_ROOT = join(REPO_ROOT, 'packages/kojo-syntax-tree');
const GRAMMAR_WASM = join(SYNTAX_ROOT, 'tree-sitter-kojo2.wasm');
const HIGHLIGHTS_SCM = join(SYNTAX_ROOT, 'queries/v2/highlights.scm');
const FULL_FIXTURE = join(SYNTAX_ROOT, 'tests/v2-fixtures/full.kojo2');

const FULL_TEXT = readFileSync(FULL_FIXTURE, 'utf8');

/** 生产资源的 Node 侧替身：直接读 workspace 内文件（不 fetch、不联网） */
function realDeps(overrides: Partial<Kojo2RuntimeDeps> = {}): Kojo2RuntimeDeps {
  return {
    loadAssets: async () => ({
      runtimeWasmUrl: RUNTIME_WASM,
      grammarWasm: GRAMMAR_WASM,
      highlightsQuery: readFileSync(HIGHLIGHTS_SCM, 'utf8'),
    }),
    ...overrides,
  };
}

async function loadRealRuntime(deps: Kojo2RuntimeDeps = realDeps()): Promise<Kojo2TreeSitterRuntime> {
  const result = await getKojo2TreeSitterRuntime(deps);
  if (!result.ok) throw new Error(`真 wasm 装载失败：${result.reason}: ${result.message}`);
  return result.runtime;
}

/** 结构快照：节点类型 + 码元跨度 + 错误/缺失标记（比 s-expression 多带位置，能抓住"同形不同位"） */
function structureOf(root: SyntaxNode): string[] {
  const lines: string[] = [];
  const walk = (node: SyntaxNode): void => {
    const marks = `${node.hasError ? '!error' : ''}${node.isMissing ? '!missing' : ''}`;
    lines.push(`${node.type}@${node.startIndex}..${node.endIndex}${marks}`);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return lines;
}

function replaceOnce(text: string, needle: string, replacement: string): string {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`测试编辑没找到锚点：${needle.slice(0, 40)}`);
  return text.slice(0, at) + replacement + text.slice(at + needle.length);
}

function capture(name: string, startRow: number, startCol: number, endRow: number, endCol: number): Kojo2Capture {
  return {
    name,
    startPosition: { row: startRow, column: startCol },
    endPosition: { row: endRow, column: endCol },
  };
}

afterEach(async () => {
  await disposeKojo2TreeSitterRuntime();
});

describe('单例与懒加载', () => {
  it('并发调用共享同一条 Promise 与同一个运行时（幂等）', async () => {
    const first = getKojo2TreeSitterRuntime(realDeps());
    const second = getKojo2TreeSitterRuntime();
    expect(second).toBe(first);

    const [a, b] = await Promise.all([first, second]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.runtime).toBe(b.runtime);
    expect(a.runtime.initMs).toBeGreaterThanOrEqual(0);

    // 就绪之后再取，仍然是同一条（不会因为"已经 ready"另起一次装载）
    expect(getKojo2TreeSitterRuntime()).toBe(first);
  });

  it('dispose 后可重新装载；旧运行时的调用回 disposed 而不是抛', async () => {
    const first = await getKojo2TreeSitterRuntime(realDeps());
    expect(first.ok).toBe(true);
    const firstPromise = getKojo2TreeSitterRuntime();
    await disposeKojo2TreeSitterRuntime();

    if (first.ok) {
      const afterDispose = first.runtime.parse('> 已经释放了。\n');
      expect(afterDispose.ok).toBe(false);
      if (!afterDispose.ok) expect(afterDispose.reason).toBe('disposed');
    }

    const secondPromise = getKojo2TreeSitterRuntime(realDeps());
    expect(secondPromise).not.toBe(firstPromise);
    const second = await secondPromise;
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) expect(second.runtime).not.toBe(first.runtime);
    if (second.ok) expect(second.runtime.initMs).toBeGreaterThanOrEqual(0);
  });
});

describe('真 wasm：解析与增量等价', () => {
  it('整篇解析 2.0 夹具：根节点 source_file、零 ERROR', async () => {
    const runtime = await loadRealRuntime();
    const parsed = runtime.parse(FULL_TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.incremental).toBe(false);
    expect(parsed.changedRanges).toEqual([]);
    expect(parsed.textLength).toBe(FULL_TEXT.length);
    expect(parsed.rootNode.type).toBe('source_file');
    expect(parsed.rootNode.hasError).toBe(false);
    expect(parsed.rootNode.descendantsOfType('speech').length).toBeGreaterThanOrEqual(10);
    parsed.tree.delete();
  });

  it('增量 parse 与整篇 parse 结构逐节点等价（连续 6 步编辑，含块头边界）', async () => {
    const runtime = await loadRealRuntime();
    const initial = runtime.parse(FULL_TEXT);
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;

    const steps: Array<{ name: string; apply(text: string): string }> = [
      {
        name: '行后插入一行旁白',
        apply: (text) =>
          replaceOnce(
            text,
            '> 晨光透过鸟居，斑驳地洒在石阶上。',
            '> 晨光透过鸟居，斑驳地洒在石阶上。\n> 一只猫从石阶旁走过。',
          ),
      },
      {
        name: '改旁白正文里的一个词',
        apply: (text) => replaceOnce(text, '斑驳地', '柔和地'),
      },
      {
        name: '删掉刚插入的那一行',
        apply: (text) => replaceOnce(text, '\n> 一只猫从石阶旁走过。', ''),
      },
      {
        name: '在块头前插入一行台词（顶层边界）',
        apply: (text) =>
          replaceOnce(text, '# 幕 神社傍晚\n@算', '# 幕 神社傍晚\n灵梦：「走吧。」\n@算'),
      },
      {
        name: '块体内追加一条赋值',
        apply: (text) => replaceOnce(text, '    人数 = 队伍状态.长度', '    人数 = 队伍状态.长度\n    今天已触发 = 人数'),
      },
      {
        name: '池体末尾插入一个新分支头（前一枚节点是正文）',
        apply: (text) =>
          replaceOnce(
            text,
            '    ? 否\n        「亲爱的，早安~」(拥抱)\n        > 她把脸埋进你的肩膀。',
            '    ? 否\n        「亲爱的，早安~」(拥抱)\n        > 她把脸埋进你的肩膀。\n    ? 恋慕 < 50\n        「……早。」',
          ),
      },
    ];

    let text = FULL_TEXT;
    let oldTree: Tree = initial.tree;
    for (const step of steps) {
      const nextText = step.apply(text);
      expect(nextText, `${step.name}：编辑没生效`).not.toBe(text);

      const incremental = runtime.parse(nextText, oldTree);
      expect(incremental.ok, `${step.name}：增量解析失败`).toBe(true);
      if (!incremental.ok) break;
      expect(incremental.incremental, `${step.name}：这一趟没用上旧树`).toBe(true);
      expect(incremental.changedRanges.length, `${step.name}：changedRanges 条数`).toBe(1);

      const full = runtime.parse(nextText);
      expect(full.ok, `${step.name}：整篇解析失败`).toBe(true);
      if (!full.ok) break;
      expect(structureOf(incremental.rootNode), `${step.name}：增量与整篇结构不等价`).toEqual(
        structureOf(full.rootNode),
      );

      oldTree.delete();
      full.tree.delete();
      oldTree = incremental.tree;
      text = nextText;
    }
    oldTree.delete();
  });

  it('同一棵旧树不许二次当增量基准：第二次退整篇重解，结果仍正确', async () => {
    const runtime = await loadRealRuntime();
    const first = runtime.parse('> 第一版。\n');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = runtime.parse('> 第二版。\n', first.tree);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.incremental).toBe(true);

    // first.tree 已被 tree.edit 改写过：再拿它当基准只能整篇重解（否则差分口径会错）
    const third = runtime.parse('> 第三版，长一点。\n', first.tree);
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.incremental).toBe(false);
    expect(third.rootNode.hasError).toBe(false);
    expect(third.rootNode.descendantsOfType('narration')[0]!.text).toContain('第三版');

    first.tree.delete();
    second.tree.delete();
    third.tree.delete();
  });

  it('旧树不认识（上一代运行时留下的 / 没有文本记录）⇒ 自动退整篇重解，结果仍正确', async () => {
    const first = await loadRealRuntime();
    const borrowed = first.parse('> 上一代运行时解出的树。\n');
    expect(borrowed.ok).toBe(true);
    if (!borrowed.ok) return;
    await disposeKojo2TreeSitterRuntime();

    // 新一代运行时的 WeakMap 里没有这棵树 ⇒ 不能增量，只能整篇重解
    const second = await loadRealRuntime();
    const parsed = second.parse('> 上一代运行时解出的树，改写。\n', borrowed.tree);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.incremental).toBe(false);
    expect(parsed.rootNode.hasError).toBe(false);
    borrowed.tree.delete();
    parsed.tree.delete();
  });
});

describe('失败面：可判别、不抛、不挂', () => {
  it('wasm 缺失 ⇒ ok:false / unavailable', async () => {
    const result = await getKojo2TreeSitterRuntime({
      loadAssets: async () => ({
        runtimeWasmUrl: join(HERE, 'no-such-web-tree-sitter.wasm'),
        grammarWasm: join(HERE, 'no-such-tree-sitter-kojo2.wasm'),
      }),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unavailable');
  });

  it('装载挂起 ⇒ 按 timeoutMs 返回 ok:false / timeout，不拖住调用方', async () => {
    const started = Date.now();
    const result = await getKojo2TreeSitterRuntime({
      loadModule: () => new Promise<Kojo2TreeSitterModule>(() => {}),
      timeoutMs: 40,
    });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('timeout');
    expect(elapsed).toBeLessThan(2_000);
    expect(KOJO2_RUNTIME_TIMEOUT_MS).toBe(5_000);
  });

  it('非法输入 ⇒ ok:false / invalid-input；坏旧树归整篇而不是炸', async () => {
    const runtime = await loadRealRuntime();

    const badText = runtime.parse(42 as unknown as string);
    expect(badText.ok).toBe(false);
    if (!badText.ok) expect(badText.reason).toBe('invalid-input');

    const nullText = runtime.parse(null as unknown as string);
    expect(nullText.ok).toBe(false);
    if (!nullText.ok) expect(nullText.reason).toBe('invalid-input');

    const badTree = runtime.parse('> 好行照常解析。\n', { nope: true } as unknown as Tree);
    expect(badTree.ok).toBe(true);
    if (badTree.ok) {
      expect(badTree.incremental).toBe(false);
      expect(badTree.rootNode.descendantsOfType('narration').length).toBe(1);
      badTree.tree.delete();
    }

    const badNode = runtime.captures({} as unknown as SyntaxNode);
    expect(badNode.ok).toBe(false);
    if (!badNode.ok) expect(badNode.reason).toBe('invalid-input');
  });

  it('没有 highlights 查询 ⇒ captures 回 query-unavailable，但 parse 仍可用', async () => {
    const runtime = await loadRealRuntime(
      realDeps({
        loadAssets: async () => ({ runtimeWasmUrl: RUNTIME_WASM, grammarWasm: GRAMMAR_WASM }),
      }),
    );
    const parsed = runtime.parse('> 只解不看色。\n');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const captured = runtime.captures(parsed.rootNode);
    expect(captured.ok).toBe(false);
    if (!captured.ok) expect(captured.reason).toBe('query-unavailable');
    parsed.tree.delete();
  });
});

describe('Monaco 适配：capture → 区间（纯函数）', () => {
  it('1 基行列、跨行拆段、none 不上色、@ 前缀容错', () => {
    const tokens = capturesToTokenSpans(
      [
        capture('keyword.control', 0, 0, 0, 4),
        capture('string', 1, 2, 2, 3),
        capture('none', 1, 0, 1, 1),
        capture('@comment', 3, 2, 3, 5),
        // 与跨行捕获的第 2 行段重叠：该行从更早的列 2 开始 ⇒ 先到者留下，跨行段那一行丢掉
        capture('string', 1, 1, 1, 3),
      ],
      { lineCount: 4, maxColumn: (line) => (line === 2 ? 10 : line === 3 ? 8 : 20) },
    );
    expect(tokens).toEqual([
      { line: 1, startColumn: 1, endColumn: 5, tokenType: 'keyword.control' },
      { line: 2, startColumn: 2, endColumn: 4, tokenType: 'string' },
      { line: 3, startColumn: 1, endColumn: 4, tokenType: 'string' },
      { line: 4, startColumn: 3, endColumn: 6, tokenType: 'comment' },
    ]);
  });

  it('越界 / 倒置 / 零宽 / NaN / 超长跨度一律丢，绝不抛', () => {
    const bad: Kojo2Capture[] = [
      capture('string', -1, 0, 0, 4),
      capture('string', 0, 0, 400, 4), // 行越界（lineCount 300）
      capture('string', 2, 0, 1, 4), // 倒置
      capture('string', 0, 1, 0, 1), // 零宽
      capture('string', 0, Number.NaN, 0, 2),
      capture('string', 0, 0, 0, Number.POSITIVE_INFINITY),
      capture('string', 0, 999, 0, 1000), // 列越界 ⇒ 夹成零宽后丢
      capture('string', 0, 0, 250, 3), // 跨 251 行
    ];
    expect(() => capturesToTokenSpans(bad, { lineCount: 300, maxColumn: () => 5 })).not.toThrow();
    expect(capturesToTokenSpans(bad, { lineCount: 300, maxColumn: () => 5 })).toEqual([]);

    expect(capturesToTokenSpans(null, { lineCount: 3 })).toEqual([]);
    expect(capturesToTokenSpans([], { lineCount: 3 })).toEqual([]);
    expect(capturesToTokenSpans([capture('string', 0, 0, 0, 2)], { lineCount: Number.NaN })).toEqual([]);
    expect(capturesToTokenSpans([capture('string', 0, 0, 0, 2)], { lineCount: -1 })).toEqual([]);
    // 没有行几何时跨行捕获整条丢（不知道"行尾"在哪，不许只画半截）
    expect(capturesToTokenSpans([capture('string', 0, 0, 2, 3)], { lineCount: 5 })).toEqual([]);
  });

  it('重叠只留先到（同起点长者优先），相邻不算重叠', () => {
    const tokens = capturesToTokenSpans(
      [
        capture('string', 0, 0, 0, 10),
        capture('keyword', 0, 2, 0, 6),
        capture('number', 0, 0, 0, 4),
        capture('comment', 0, 10, 0, 14),
      ],
      { lineCount: 2, maxColumn: () => 40 },
    );
    expect(tokens).toEqual([
      { line: 1, startColumn: 1, endColumn: 11, tokenType: 'string' },
      { line: 1, startColumn: 11, endColumn: 15, tokenType: 'comment' },
    ]);
  });

  it('maxTokens 截断且不改入参', () => {
    const captures: Kojo2Capture[] = [
      capture('a', 0, 0, 0, 2),
      capture('b', 0, 3, 0, 5),
      capture('c', 0, 6, 0, 8),
    ];
    const snapshot = JSON.stringify(captures);
    expect(capturesToTokenSpans(captures, { lineCount: 1, maxTokens: 2 }).length).toBe(2);
    expect(JSON.stringify(captures)).toBe(snapshot);
  });
});

describe('运行时 captures + tokenizer 端到端', () => {
  it('真查询在 2.0 夹具上的捕获都能映射成合法行内区间', async () => {
    const runtime = await loadRealRuntime();
    const parsed = runtime.parse(FULL_TEXT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const captured = runtime.captures(parsed.rootNode);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.captures.length).toBeGreaterThan(100);

    const lineCount = FULL_TEXT.split('\n').length;
    const tokens = capturesToTokenSpans(captured.captures, { lineCount });
    expect(tokens.length).toBeGreaterThan(100);
    for (const token of tokens) {
      expect(token.line).toBeGreaterThanOrEqual(1);
      expect(token.line).toBeLessThanOrEqual(lineCount);
      expect(token.startColumn).toBeGreaterThanOrEqual(1);
      expect(token.endColumn).toBeGreaterThan(token.startColumn);
      expect(token.tokenType.length).toBeGreaterThan(0);
    }
    const types = new Set(tokens.map((token) => token.tokenType));
    expect(types.has('keyword.control')).toBe(true);
    expect(types.has('string')).toBe(true);
    expect(types.has('comment')).toBe(true);
    parsed.tree.delete();
  });
});
