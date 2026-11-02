import { describe, expect, it } from 'vitest';
import type { EditorCodeLens, FileIO, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { labelLenses } from '../src/label-lens';
import { parseErbText } from '../src/scanner';
import { makeComputeStub } from './support';

/**
 * `$` 标签行上注解（T12）单测。
 *
 * 判据复用两条既有单一真源：跳转族表 `JUMP_FAMILY`（`symbols.ts`，与标签转定义同源）、
 * 可见行遍历 `visibleCodeLines`（`references.ts`，与反向索引同源）。这里钉的是：
 * 计数口径（函数局部作用域 / 按处去重 / 大小写归一）、fail-open 边界、与函数注解的
 * 共存（经真插件装配）。
 */

const L = (...lines: string[]): string => lines.join('\n');
const A = '/t/A.ERB';

function labelsOf(text: string): EditorCodeLens[] {
  return labelLenses(parseErbText(text, A), text);
}

describe('labelLenses · 引用计数', () => {
  it('同函数内两处 JUMP ⇒ 「2 处引用」，落点指向第一处（1 基列）', () => {
    const text = L('@F', 'GOTO SKIP', 'PRINT A', '$SKIP', 'PRINT B', 'TRYJUMP SKIP', 'RETURN');
    const out = labelsOf(text);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      line: 4,
      label: '2 处引用',
      target: { filePath: A, line: 2, column: 6 }, // GOTO 之后的首个记号
    });
  });

  it('大小写不敏感：`goto skip` 命中 `$SKIP`（Emuera 标签名归一大写）', () => {
    const out = labelsOf(L('@F', 'goto skip', '$SKIP'));
    expect(out[0]!.label).toBe('1 处引用');
  });

  it('TRYJUMP / TRYGOTO 同族同判；0 引用显示「未引用」且不可点', () => {
    const out = labelsOf(L('@F', 'TRYGOTO L2', 'PRINT X', '$L1', '$L2'));
    expect(out).toEqual([
      { line: 4, label: '未引用' }, // 无 target = 不可点
      { line: 5, label: '1 处引用', target: { filePath: A, line: 2, column: 9 } },
    ]);
  });

  it('函数局部作用域：跨函数的 `JUMP 同名` 不算引用（F1 自己那处照常计）', () => {
    const text = L('@F1', 'JUMP SAME', '$SAME', 'RETURN', '@F2', 'JUMP SAME', 'RETURN');
    const out = labelsOf(text);
    // F1 的 JUMP（第 2 行）是 $SAME 的正当引用；F2 的同名 JUMP 不归它（无同名标签可归）
    expect(out).toEqual([{ line: 3, label: '1 处引用', target: { filePath: A, line: 2, column: 6 } }]);
  });

  it('按"处"计：同一条 JUMP 行只算一处（防御；ERB 一行一条语句）', () => {
    const out = labelsOf(L('@F', 'JUMP L1', '$L1'));
    expect(out[0]!.label).toBe('1 处引用');
  });

  it('成员访问与不裸的槽位不算：`JUMP FLAG:X` / `JUMP {X}` / `TRYJUMPFORM X` 都不进计数', () => {
    const text = L('@F', 'JUMP FLAG:X', 'JUMP {X}', 'TRYJUMPFORM L1', '$L1');
    const out = labelsOf(text);
    expect(out).toEqual([{ line: 5, label: '未引用' }]);
  });

  it('注释、[SKIPSTART] 区、`$` / `#` 行不扫（visibleCodeLines 屏蔽面）', () => {
    const text = L('@F', '; JUMP L1', '[SKIPSTART]', 'JUMP L1', '[SKIPEND]', '#DIM X', '$L1');
    const out = labelsOf(text);
    expect(out).toEqual([{ line: 7, label: '未引用' }]);
  });

  it('无标签文件 ⇒ 空数组（解析器不给空 labels，这里零分支）', () => {
    expect(labelsOf(L('@F', 'RETURN'))).toEqual([]);
  });
});

/* ---------------- 接线：erb-usage-lens 与函数注解共存（真插件装配） ---------------- */

const B = '/t/B.ERB';
const FILES: Record<string, string> = {
  [A]: '; 被调方\n@ALPHA\n\tRETURN 1\n',
  [B]: '; 标签与函数共存\n@ENTRY\n\tCALL HELPER\n\tGOTO NEAR\n\t$NEAR\n\tPRINT X\n\tRETURN\n@HELPER\n\tRETURN 1\n',
};

function fakeIO(): FileIO {
  return {
    async readText(path: string) {
      const text = FILES[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = FILES[path];
        return text === undefined ? null : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: null };
      });
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: null, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(FILES)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false }));
    },
  } as unknown as FileIO;
}

interface SlotRecord {
  kind: string;
  contribution: Record<string, unknown>;
}

function activate(): { services: Map<string, unknown>; slots: SlotRecord[] } {
  const services = new Map<string, unknown>();
  const slots: SlotRecord[] = [];
  const disposers: Array<() => void> = [];
  const noop = (): void => undefined;
  const ctx = {
    pluginId: 'erb-parser',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: {
      on: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      once: (() => noop) as unknown as (t: string, h: (p: unknown) => void) => Unsubscribe,
      emit: noop,
    },
    inject: <T,>(key: string): T => {
      if (key === 'kernel.io') return fakeIO() as unknown as T;
      if (key === 'kernel.compute') return makeComputeStub() as unknown as T;
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string, value: unknown) => services.set(key, value),
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    slots: {
      register: (kind: string, contribution: Record<string, unknown>) => {
        slots.push({ kind, contribution });
        return noop;
      },
      query: () => [],
    },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return { services, slots };
}

describe('erb-usage-lens · 标签注解与函数注解共存', () => {
  function codeLensOf(slots: SlotRecord[]): {
    provide(request: unknown): { kind: string; lenses: EditorCodeLens[] } | undefined;
  } {
    const hit = slots.find((s) => s.kind === 'ui.editor.languageService' && s.contribution.id === 'erb-usage-lens');
    if (!hit) throw new Error('erb-usage-lens 未注册');
    return hit.contribution as unknown as { provide(r: unknown): { kind: string; lenses: EditorCodeLens[] } | undefined };
  }

  it('索引未建 ⇒ undefined（缺席只有一个含义的口径不变）', () => {
    const { slots } = activate();
    expect(codeLensOf(slots).provide({ kind: 'codeLens', path: B, text: FILES[B]! })).toBeUndefined();
  });

  it('索引建好后：函数行与 `$` 标签行的注解同篇产出、按行升序', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as { buildIndex(roots: string[]): Promise<unknown> }).buildIndex(['/t']);
    const res = codeLensOf(slots).provide({ kind: 'codeLens', path: B, text: FILES[B]! });
    expect(res).toBeDefined();
    // $NEAR 的引用（第 4 行 GOTO）与 @HELPER 的调用方（第 3 行 CALL）同篇并存
    expect(res!.lenses).toEqual([
      { line: 5, label: '1 处引用', target: { filePath: B, line: 4, column: 7 } },
      { line: 8, label: '被 1 处用到', target: { filePath: B, line: 3, column: 7 } },
    ]);
  });
});
