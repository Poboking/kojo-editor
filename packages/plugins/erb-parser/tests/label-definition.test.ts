/**
 * `$` 标签转定义（T4，2026-10-16 语言服务批）单测。
 *
 * 三层各自钉死：scanner 的标签收集（归属判据 = 函数局部作用域）、快照往返
 * （additive 字段不许在盘上丢失）、`definitionTargetsAt` 的标签腿（跳转系名字槽
 * → 本函数标签；找不到 = 空数组不猜、也不落函数名那把尺子）。
 * 装配面用本文件自带的极小上下文体（不动 `plugin.test.ts` / `language-service.test.ts`
 * 的共享夹具，避免与并行批次撞同一文件）。
 */
import { functionLookupOf } from '@kojo/plugin-api';
import { describe, expect, it } from 'vitest';
import type { ErbFunctionRef, ErbIndex, ErbParserService, FileIO, PluginContext, Unsubscribe } from '@kojo/plugin-api';
import { createErbParserPlugin } from '../src/plugin';
import { parseErbText } from '../src/scanner';
import { decodeEntries, encodeEntries } from '../src/snapshot';
import { definitionTargetsAt, functionInFile } from '../src/symbols';
import { makeComputeStub } from './support';

const fnRef = (name: string, startLine = 9): ErbFunctionRef => ({
  name,
  normalizedName: name.toUpperCase(),
  filePath: '/a.ERB',
  startLine,
  endLine: startLine + 1,
});

const idx = (byName: Record<string, ErbFunctionRef[]>): ErbIndex =>
  ({ files: new Map(), byName: functionLookupOf(new Map(Object.entries(byName))) }) as unknown as ErbIndex;

describe('parseErbText · $ 标签收集（函数局部作用域）', () => {
  it('函数内标签：名、行、归属函数；跨函数各归各（同名不合并）', () => {
    const file = parseErbText('@F\n$TOP\n\tGOTO TOP\n@G\n$TOP\n', '/a.ERB');
    expect(file.labels).toEqual([
      { name: 'TOP', line: 2, functionStartLine: 1 },
      { name: 'TOP', line: 5, functionStartLine: 4 },
    ]);
  });

  it('顶层（第一个 `@` 之前）不收——引擎不编译它', () => {
    expect(parseErbText('$ORPHAN\n@F\n', '/a.ERB').labels).toBeUndefined();
  });

  it('[SKIPSTART] 区内不收', () => {
    expect(parseErbText('@F\n[SKIPSTART]\n$HIDDEN\n[SKIPEND]\n', '/a.ERB').labels).toBeUndefined();
  });

  it('无标签 = 缺省（不给空数组，索引不堆空字段）', () => {
    expect(parseErbText('@F\n\tRETURN 1\n', '/a.ERB').labels).toBeUndefined();
  });

  it('标签名截到终止符（空白 / `;`），行尾注释不进名字；裸 `$` 不是标签', () => {
    expect(parseErbText('@F\n$NEXT ; 注释\n', '/a.ERB').labels).toEqual([{ name: 'NEXT', line: 2, functionStartLine: 1 }]);
    expect(parseErbText('@F\n$\n', '/a.ERB').labels).toBeUndefined();
  });
});

describe('definitionTargetsAt · 标签腿（JUMP/GOTO 系 → 本函数标签）', () => {
  it('同函数命中：GOTO NEXT → 标签定义行', () => {
    const text = '@F\n$NEXT\n\tPRINTL A\n\tGOTO NEXT\n';
    expect(definitionTargetsAt(idx({}), '/a.ERB', text, 4, 7)).toEqual([
      { name: 'NEXT', normalizedName: 'NEXT', filePath: '/a.ERB', startLine: 2, endLine: 2, nameColumn: 2 },
    ]);
  });

  it('大小写不敏感（`goto next` 命中 `$Next`）', () => {
    const text = '@F\n$Next\n\tgoto next\n';
    expect(definitionTargetsAt(idx({}), '/a.ERB', text, 3, 7)).toEqual([
      { name: 'Next', normalizedName: 'NEXT', filePath: '/a.ERB', startLine: 2, endLine: 2, nameColumn: 2 },
    ]);
  });

  it('跨函数不命中：GOTO 在另一个函数里 → 空数组（标签是函数局部作用域）', () => {
    const text = '@F\n$NEXT\n@G\n\tGOTO NEXT\n';
    expect(definitionTargetsAt(idx({}), '/a.ERB', text, 4, 7)).toEqual([]);
  });

  it('无标签 → 空数组（不猜）', () => {
    expect(definitionTargetsAt(idx({}), '/a.ERB', '@F\n\tGOTO NOWHERE\n', 2, 7)).toEqual([]);
  });

  it('跳转系名字槽不落函数名那把尺子：`GOTO ALPHA` ≠ 调用 ALPHA（哪怕 ALPHA 在索引里）', () => {
    const index = idx({ ALPHA: [fnRef('ALPHA')] });
    expect(definitionTargetsAt(index, '/a.ERB', '@F\n\tGOTO ALPHA\n', 2, 7)).toEqual([]);
  });

  it('动态目标不猜：`GOTO (X)` / `GOTO {X}` → 空数组', () => {
    expect(definitionTargetsAt(idx({}), '/a.ERB', '@F\n\tGOTO (X)\n', 2, 8)).toEqual([]);
    expect(definitionTargetsAt(idx({}), '/a.ERB', '@F\n\tGOTO {X}\n', 2, 8)).toEqual([]);
  });

  it('[SKIPSTART] 内的标签不认', () => {
    const text = '@F\n[SKIPSTART]\n$NEXT\n[SKIPEND]\n\tGOTO NEXT\n';
    expect(definitionTargetsAt(idx({}), '/a.ERB', text, 5, 7)).toEqual([]);
  });

  it('光标在跳转关键字自身上 → 照旧走函数名腿（JUMP/GOTO 不是收录名 ⇒ 空）', () => {
    expect(definitionTargetsAt(idx({}), '/a.ERB', '@F\n\tGOTO NEXT\n', 2, 3)).toEqual([]);
  });

  it('非跳转行原样走函数名腿（回归：CALL FOO 命中定义）', () => {
    const index = idx({ FOO: [fnRef('FOO')] });
    expect(definitionTargetsAt(index, '/a.ERB', '@F\n\tCALL FOO\n', 2, 7)).toEqual([fnRef('FOO')]);
  });
});

describe('functionInFile · 包围判定单源（functionAt 与标签腿共用）', () => {
  const file = parseErbText('@F\n\tA\n@G\n\tB\n', '/a.ERB');
  it('落在函数区间内 → 该函数；函数外 / 越界 → undefined', () => {
    expect(functionInFile(file, 1)?.name).toBe('F');
    expect(functionInFile(file, 3)?.name).toBe('G');
    expect(functionInFile(file, 2)?.name).toBe('F');
    expect(functionInFile(file, 99)).toBeUndefined();
  });
});

describe('snapshot v6 · labels 上盘往返（additive 字段不许在盘上丢）', () => {
  it('带标签文件 encode → decode 与 parseErbText 直出逐字段相同', () => {
    const parsed = parseErbText('@F\n$NEXT\n\tGOTO NEXT\n@G\n$OTHER\n', '/a.ERB');
    const entries = { '/a.ERB': { mtimeMs: 1, size: 10, textLength: 10, file: parsed } };
    const back = decodeEntries(JSON.parse(JSON.stringify(encodeEntries(entries))))!;
    expect(back['/a.ERB']!.file).toEqual(parsed);
  });

  it('无标签文件：盘上第 9 位为空数组，还原后仍缺省（不给空数组）', () => {
    const parsed = parseErbText('@F\n', '/a.ERB');
    const payload = JSON.parse(
      JSON.stringify(encodeEntries({ '/a.ERB': { mtimeMs: 1, size: 1, textLength: 1, file: parsed } })),
    ) as Record<string, unknown[]>;
    expect(payload['/a.ERB']![8]).toEqual([]);
    expect(decodeEntries(payload)![`/a.ERB`]!.file.labels).toBeUndefined();
  });

  it('标签元组损坏 → null（fail-closed，懒还原不打折校验）', () => {
    const parsed = parseErbText('@F\n$NEXT\n', '/a.ERB');
    const payload = JSON.parse(
      JSON.stringify(encodeEntries({ '/a.ERB': { mtimeMs: 1, size: 1, textLength: 1, file: parsed } })),
    ) as Record<string, unknown[]>;
    (payload['/a.ERB']![8] as unknown[])[0] = ['NEXT', 2]; // 元数不对
    expect(decodeEntries(payload)).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 装配面：erb-definition 贡献的标签导航（走既有 definition kind，零新判别成员）
 * ------------------------------------------------------------------------- */

const A = '/t/A.ERB';
const FILES: Record<string, string> = {
  [A]: '@F\n$NEXT\n\tPRINTL A\n\tGOTO NEXT\n',
};
const MTIME = 1000;

function fakeIO(): FileIO {
  return {
    async readText(path: string) {
      const text = FILES[path];
      if (text === undefined) throw new Error(`not found: ${path}`);
      return { path, text, encoding: 'utf-8', eol: 'lf', mtimeMs: MTIME };
    },
    async readTexts(paths: readonly string[]) {
      return paths.map((path) => {
        const text = FILES[path];
        return text === undefined
          ? null
          : { path, text, encoding: 'utf-8' as const, eol: 'lf' as const, mtimeMs: MTIME };
      });
    },
    async stat(path: string) {
      const text = FILES[path];
      return text === undefined ? null : { size: text.length, mtimeMs: MTIME, isDirectory: false };
    },
    async walkDir(root: string) {
      return Object.keys(FILES)
        .filter((p) => p.startsWith(root))
        .map((p) => ({ name: p.split('/').pop() ?? p, path: p, isDirectory: false, mtimeMs: MTIME, size: FILES[p]!.length }));
    },
  } as unknown as FileIO;
}

function activate(): { services: Map<string, unknown>; languageServices: Map<string, Record<string, unknown>> } {
  const services = new Map<string, unknown>();
  const languageServices = new Map<string, Record<string, unknown>>();
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
        if (kind === 'ui.editor.languageService') languageServices.set(contribution.id as string, contribution);
        return noop;
      },
      query: () => [],
    },
    onDispose: noop,
  } as unknown as PluginContext;
  createErbParserPlugin().activate(ctx);
  return { services, languageServices };
}

type DefinitionContribution = {
  provide(request: { kind: string; path: string; text: string; line: number; column: number; project: null }):
    | { kind: string; locations: { filePath: string; line: number; column?: number; span?: { columnStart: number; columnEnd: number } }[] }
    | undefined;
};

describe('erb-parser · erb-definition 装配（标签导航）', () => {
  it('索引未建 ⇒ 本地标签腿照答（认这门语言就作答，不因索引缺席弃权）', () => {
    const { languageServices } = activate();
    const c = languageServices.get('erb-definition') as unknown as DefinitionContribution;
    expect(c.provide({ kind: 'definition', path: A, text: FILES[A]!, line: 4, column: 7, project: null })).toEqual({
      kind: 'definition',
      locations: [
        {
          filePath: A,
          line: 2,
          column: 2,
          kind: 'definition',
          span: { columnStart: 2, columnEnd: 6 },
        },
      ],
    });
  });

  it('GOTO NEXT → 跳到本函数的 $NEXT 标签行（既有 definition 通道，零新 kind）', async () => {
    const { services, languageServices } = activate();
    await (services.get('erb.parser') as ErbParserService).buildIndex(['/t']);
    const c = languageServices.get('erb-definition') as unknown as DefinitionContribution;
    expect(c.provide({ kind: 'definition', path: A, text: FILES[A]!, line: 4, column: 7, project: null })).toEqual({
      kind: 'definition',
      // W-DEF-COL：标签腿的定义位也带列（`$NEXT` ⇒ 名字从第 2 列起，4 个码元）；
      // `kind` 用既有值域（`definition`），不新造一格
      locations: [
        {
          filePath: A,
          line: 2,
          column: 2,
          kind: 'definition',
          span: { columnStart: 2, columnEnd: 6 },
        },
      ],
    });
  });
});
