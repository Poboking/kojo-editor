/**
 * 语言服务接线单测（`ui.editor.languageService` 槽 + `erb.parser.functionAt`）。
 *
 * 与 `symbols.test.ts` 的分工：那里测**纯逻辑**，这里测**装配**——槽确实注册了、
 * `functionAt` 确实能经服务拿到索引、三态返回（不认 / 认但无定义 / 有目标）确实成立。
 * 用本文件自带的极小上下文体（不动 `plugin.test.ts` 的共享夹具，避免与别人并行改同一文件）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, ErbParserService, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { makeComputeStub } from './support';

const A = '/t/A.ERB';
const B = '/t/B.ERB';
const FILES: Record<string, string> = {
  [A]: '; 目标文件\n@ALPHA(ARG)\n\tRETURN 1\n',
  [B]: '@CALLER\n\tCALL ALPHA(1)\n\tCALL NOPE\n',
};

function fakeIO(): FileIO {
  return {
    async readText(path: string) {
      const text = FILES[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: null };
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

function activate(): {
  services: Map<string, unknown>;
  slots: SlotRecord[];
  dispose: () => void;
} {
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
    storage: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      keys: async () => [],
    },
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
  return { services, slots, dispose: () => disposers.reverse().forEach((d) => d()) };
}

type LanguageServiceContribution = {
  id: string;
  provide(request: unknown): { kind: string; locations: { filePath: string; line: number }[] } | undefined;
};

/** 取语言服务贡献（注册顺序里它是第三枚：decorator / codeAction / languageService） */
function languageServiceOf(slots: SlotRecord[]): LanguageServiceContribution {
  const hit = slots.find((s) => s.kind === 'ui.editor.languageService');
  if (!hit) throw new Error('ui.editor.languageService 未注册');
  return hit.contribution as unknown as LanguageServiceContribution;
}

describe('erb-parser · ui.editor.languageService 装配', () => {
  it('注册了语言服务贡献（id 稳定，便于宿主/诊断指认）', () => {
    const { slots } = activate();
    expect(slots.filter((s) => s.kind === 'ui.editor.languageService')).toHaveLength(1);
    expect(languageServiceOf(slots).id).toBe('erb-definition');
  });

  it('不认 `.kojo`（返回 undefined）；认 ERB 但记号未收录 → 空数组', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const c = languageServiceOf(slots);

    expect(c.provide({ kind: 'definition', path: '/t/X.kojo', text: 'CALL ALPHA', line: 1, column: 8 })).toBe(
      undefined,
    );

    const none = c.provide({
      kind: 'definition',
      path: B,
      text: FILES[B]!,
      line: 3, // `CALL NOPE`
      column: 8,
      project: null,
    });
    expect(none).toEqual({ kind: 'definition', locations: [] });
  });

  it('认 ERB：跨文件命中定义行（`.kojo` 那条线没有产出 / 非该项目文件）', async () => {
    const { services, slots } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const c = languageServiceOf(slots);
    const res = c.provide({
      kind: 'definition',
      path: B,
      text: FILES[B]!,
      line: 2, // `CALL ALPHA(1)`
      column: 8,
      project: null,
    });
    expect(res).toEqual({ kind: 'definition', locations: [{ filePath: A, line: 2 }] });
  });

  it('索引未建（未打开项目）→ undefined（不是本包的活，别谎报"没有定义"）', () => {
    const { slots } = activate();
    const c = languageServiceOf(slots);
    expect(c.provide({ kind: 'definition', path: B, text: FILES[B]!, line: 2, column: 8, project: null })).toBe(
      undefined,
    );
  });

  it('`erb.parser.functionAt` 只读当前索引：未建 → undefined；建好 → 包围反查', async () => {
    const { services } = activate();
    const parser = services.get('erb.parser') as ErbParserService;
    expect(parser.functionAt!(B, 2)).toBeUndefined();
    await parser.buildIndex(['/t']);
    // A 的第 1 行是注释（不在任何函数体内）→ undefined；2..3 才是 @ALPHA 的区间
    expect(parser.functionAt!(A, 1)).toBeUndefined();
    expect(parser.functionAt!(A, 2)?.name).toBe('ALPHA');
    expect(parser.functionAt!(A, 3)?.name).toBe('ALPHA');
    expect(parser.functionAt!(A, 99)).toBeUndefined();
  });
});
