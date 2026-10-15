/**
 * 语言服务接线单测（kojo-sugar 侧的 `ui.editor.languageService` 贡献）。
 *
 * 与 `definition.test.ts` 的分工：那里测**纯逻辑**，这里测**装配**——贡献确实注册、
 * 文件门确实生效（只认 `.kojo`，ERB 让给 erb-parser）、未打开项目时是"认但无目标"
 * 而不是崩或谎报。
 *
 * 用本文件自带的极小上下文体（kojo-sugar 现有测试都是服务级，没有插件级夹具）。
 */

import { describe, expect, it } from 'vitest';
import type { FileIO, PluginContext } from '@kojo/plugin-api';
import { KernelServices } from '@kojo/plugin-api';
import { createKojoSugarPlugin } from '../src/index';

interface SlotRecord {
  kind: string;
  contribution: Record<string, unknown>;
}

function activate(): { slots: SlotRecord[]; provided: string[] } {
  const slots: SlotRecord[] = [];
  const provided: string[] = [];
  const noop = (): void => undefined;
  const slotApi = {
    query: () => [],
    register: (kind: string, contribution: Record<string, unknown>) => {
      slots.push({ kind, contribution });
      return noop;
    },
  };
  const ctx = {
    pluginId: 'kojo-sugar',
    log: { debug: noop, info: noop, warn: noop, error: noop },
    bus: { on: () => noop, once: () => noop, emit: noop },
    inject: <T,>(key: string): T => {
      if (key === KernelServices.Project) return { current: () => null } as unknown as T;
      if (key === KernelServices.Slots) return slotApi as unknown as T;
      if (key === KernelServices.IO) return {} as unknown as T;
      // 其余（state.replay / erb.parser）走软取：抛错由装配层吞掉
      throw new Error(`unexpected inject: ${key}`);
    },
    provide: (key: string) => {
      provided.push(key);
    },
    storage: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, keys: async () => [] },
    slots: slotApi,
    onDispose: noop,
  } as unknown as PluginContext;
  createKojoSugarPlugin().activate(ctx);
  return { slots, provided };
}

type LanguageServiceContribution = {
  id: string;
  provide(request: unknown): { kind: string; locations: unknown[] } | undefined;
};

describe('kojo-sugar · ui.editor.languageService 装配', () => {
  it('注册了语言服务贡献（id 稳定）；`.kojo` 之外的文件一律不认', () => {
    const { slots } = activate();
    const hit = slots.find((s) => s.kind === 'ui.editor.languageService');
    expect(hit).toBeDefined();
    const c = hit!.contribution as unknown as LanguageServiceContribution;
    expect(c.id).toBe('kojo-definition');

    // ERB 让给 erb-parser（两条线各管自己认得的文件）
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.ERB', text: 'CALL X', line: 1, column: 8 })).toBe(
      undefined,
    );
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.erb', text: 'CALL X', line: 1, column: 8 })).toBe(
      undefined,
    );
    expect(c.provide({ kind: 'definition', path: 'C:\\p\\a.txt', text: 'CALL X', line: 1, column: 8 })).toBe(
      undefined,
    );
  });

  it('`.kojo`：未打开项目（无索引）→ 认这个文件但给空目标（不崩、不猜）', () => {
    const { slots } = activate();
    const c = slots.find((s) => s.kind === 'ui.editor.languageService')!.contribution as unknown as LanguageServiceContribution;
    // 纯注释源：转译无 error，但产物里没有 `@` 头 → 自证腿放弃 → 索引缺席 → 空
    const res = c.provide({
      kind: 'definition',
      path: 'C:\\p\\a.kojo',
      text: '; 空口上\n',
      line: 1,
      column: 1,
    });
    expect(res).toEqual({ kind: 'definition', locations: [] });
  });

  it('字体能力服务仍在（装配未被本次改动破坏）', () => {
    const { provided } = activate();
    expect(provided).toContain('sugar.transpile');
  });
});
