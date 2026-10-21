/**
 * 「全部替换」执行器（`ui/search-replace-exec.ts`，W8 XLANG-RENAME）单测。
 *
 * 钉的是**替换与 F2 共写一条通道**这件事，不重复 `search-replace.test.ts` 的匹配纯逻辑：
 * ① 未打开文件走 `rewriteClosedFile`（与 rename 同一个函数）：先闸写权限、现文本重扫、
 *    零改动不写盘；只读文件剔除并把「n 个文件只读未纳入」写进理由；
 * ② **对拍**——同一份输入，rename 的落点集与 replace 的命中集**逐位相同**、
 *    落盘字节**逐字相同**（两条通道说的必须是同一个文件集）；
 * ③ 注入 `nameLedger` 后，检索范围外的同名记号必须被说出来（两个写通道不再互不知情）。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbIndex } from '@kojo/plugin-api';
import { createFileReplaceRunner, type FileReplaceDeps } from '../src/ui/search-replace-exec';
import { applyReferenceEdits, createApplyToClosedFile, installErbRename, type ErbRenameHandlers } from '../src/monaco/erb-rename';
import { findNameTokenPositions, type ReferenceOccurrence } from '../src/ui/reference-utils';

const A = 'C:/p/ERB/a.ERB';
const B = 'C:/p/ERB/b.ERB';
const RO = 'C:/p/ERB/ro.ERB';

interface Harness {
  files: Map<string, string>;
  writes: string[];
  io: FileReplaceDeps['io'];
}

function harness(initial: Record<string, string>, writable: readonly string[]): Harness {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  return {
    files,
    writes,
    io: {
      isWritable: (p) => writable.includes(p),
      readText: async (p) => {
        const text = files.get(p);
        if (text === undefined) throw new Error(`没有这个文件：${p}`);
        return { text };
      },
      writeText: async (p, text) => {
        writes.push(p);
        files.set(p, text);
      },
    },
  };
}

const request = (
  files: readonly string[],
  patch: Partial<{ query: string; replaceText: string; wholeWord: boolean; caseSensitive: boolean }> = {},
) =>
  ({
    query: patch.query ?? 'FOO',
    replaceText: patch.replaceText ?? 'BAR',
    options: {
      isRegex: false,
      wholeWord: patch.wholeWord ?? true,
      caseSensitive: patch.caseSensitive ?? false,
    },
    mode: { kind: 'all' },
    files: files.map((path) => ({ path, matches: [] })),
  }) as unknown as Parameters<ReturnType<typeof createFileReplaceRunner>>[0];

describe('createFileReplaceRunner（全部替换 = 与 F2 同一条落盘通道）', () => {
  it('未打开文件走内核 io 读改写；只读文件剔除并写进理由', async () => {
    const h = harness({ [A]: 'CALL FOO\n', [RO]: 'CALL FOO\n' }, [A]); // RO 只读
    const runner = createFileReplaceRunner({ io: h.io, modelFor: () => undefined });
    const out = await runner(request([A, RO]));
    expect(out.applied).toBe(1);
    expect(out.filesChanged).toBe(1);
    expect(out.readOnlyFiles).toBe(1);
    expect(h.writes).toEqual([A]); // 只读文件一次写盘都不发生
    expect(out.errors.join('\n')).toContain('1 个文件只读未纳入');
    expect(h.files.get(A)).toBe('CALL BAR\n');
    expect(h.files.get(RO)).toBe('CALL FOO\n');
  });

  it('已打开文件走 live model（上栈的 pushEditOperations + 前后停点），不落 io 通道', async () => {
    const h = harness({ [A]: 'CALL FOO\n' }, [A]);
    const ops: Array<{ range: unknown; text: string }> = [];
    let stops = 0;
    const seen: Array<{ before: unknown; computer: unknown }> = [];
    const model = {
      getLineCount: () => 1,
      getLineContent: (n: number) => (n === 1 ? 'CALL FOO' : ''),
      pushStackElement: () => {
        stops += 1;
      },
      pushEditOperations: (before: unknown, edits: Array<{ range: unknown; text: string }>, computer: () => unknown) => {
        seen.push({ before, computer: computer() });
        ops.push(...edits);
      },
    } as unknown as Monaco.editor.ITextModel;
    const runner = createFileReplaceRunner({ io: h.io, modelFor: (p) => (p === A ? model : undefined) });
    const out = await runner(request([A]));
    expect(out.applied).toBe(1);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.text).toBe('BAR');
    expect(stops).toBe(2); // 前封口（作者那一格）+ 后封口（替换这一格）
    expect(seen).toEqual([{ before: null, computer: null }]);
    expect(h.writes).toEqual([]); // 已开标签由 Monaco 落地，不双写
  });

  it('检索结果只是预览：以现文本为准，陈旧行列不硬写（stale = 0，重扫后按现场计数）', async () => {
    const h = harness({ [B]: 'PRINTL 没有这个名字\n' }, [B]);
    const runner = createFileReplaceRunner({ io: h.io, modelFor: () => undefined });
    const out = await runner(request([B]));
    expect(out).toMatchObject({ applied: 0, filesChanged: 0, readOnlyFiles: 0 });
    expect(h.writes).toEqual([]); // 零改动不写盘（不产生备份、不弄脏文件）
  });
});

/* ============================== ② 对拍：rename 与 replace 同一输入 ⇒ 同一命中集 ============================== */

describe('rename 与「全部替换」命中集合对拍（同一份引用判据）', () => {
  const text = '@FOO(1)\nCALL FOO\nSIF FOO() == 0\n';

  /** rename 侧的落点集：台账判据（单源字符集）→ 闭文件改写 */
  const viaRename = () => {
    const positions = findNameTokenPositions(text, 'FOO');
    const spans = positions.map((p) => ({ line: p.line, column: p.column, endColumn: p.endColumn }));
    const out = applyReferenceEdits(text, spans, 'BAR', 'FOO');
    return { count: out.applied, stale: out.stale, text: out.text, spans };
  };

  /** replace 侧的命中集：走执行器的同一条闭文件通道，取实际写盘的字节 */
  const viaReplace = async () => {
    const h = harness({ [A]: text }, [A]);
    const runner = createFileReplaceRunner({ io: h.io, modelFor: () => undefined });
    const out = await runner(request([A], { query: 'FOO', replaceText: 'BAR' }));
    return { count: out.applied, text: h.files.get(A)! };
  };

  it('两侧命中处数一致、落盘字节逐字一致', async () => {
    const rename = viaRename();
    const replace = await viaReplace();
    expect(rename.stale).toBe(0);
    expect(rename.count).toBe(3);
    expect(replace.count).toBe(rename.count);
    expect(replace.text).toBe(rename.text);
    // 落点集本身也必须逐位相同（行、列、列尾）
    expect(rename.spans.map((s) => `${s.line}:${s.column}-${s.endColumn}`)).toEqual(['1:2-5', '2:6-9', '3:5-8']);
  });

  it('大小写混写时两侧仍同一集（rename 按索引归一、replace 按不敏感匹配）', async () => {
    const mixed = 'CALL foo\nSIF FOO() == 0\n';
    const rename = applyReferenceEdits(
      mixed,
      findNameTokenPositions(mixed, 'FOO').map((p) => ({ line: p.line, column: p.column, endColumn: p.endColumn })),
      'BAR',
      'FOO',
    );
    const h = harness({ [A]: mixed }, [A]);
    const runner = createFileReplaceRunner({ io: h.io, modelFor: () => undefined });
    const out = await runner(request([A], { query: 'FOO', replaceText: 'BAR' }));
    expect(rename.applied).toBe(2);
    expect(out.applied).toBe(2);
    expect(h.files.get(A)).toBe('CALL BAR\nSIF BAR() == 0\n');
  });
});

/* ============================== ②b 端到端对拍：F2 提供器与「全部替换」执行器 ============================== */

/**
 * 上一节对拍的是纯函数集；这里把**两个真实入口**（`installErbRename` 的
 * `provideRenameEdits` 与 `createFileReplaceRunner`）打到**同一份 io 桩**上，
 * 钉两件必须成立的事：
 * ① 全部可写时，两条入口写盘的**字节逐字相同**（同一条 `rewriteClosedFile` 通道，
 *    命中集来自同一份出现点台账）；
 * ② 有只读文件时，两边都点名同一段前缀「n 个文件只读未纳入」——但**语义刻意不同**：
 *    rename 走 monaco 的全或无（一处不落），replace 逐文件剔除（其余已改）。
 *    这个差集必须由 `nameLedger` 说出来，否则就是"改完名再搜仍见残留"的老暗坑。
 */
describe('F2 提供器与「全部替换」执行器端到端对拍', () => {
  const text = '@FOO(1)\nCALL FOO\nSIF FOO() == 0\n';
  /** 台账落点（与 `findNameTokenPositions` 同一组坐标：定义 + CALL 槽 + 表达式位） */
  const spansOf = (path: string) => [
    { filePath: path, line: 1, column: 2, endColumn: 5, kind: 'definition' as const },
    { filePath: path, line: 2, column: 6, endColumn: 9, kind: 'call' as const },
    { filePath: path, line: 3, column: 5, endColumn: 8, kind: 'mention' as const },
  ];

  function installRename(io: FileReplaceDeps['io'], paths: readonly string[]) {
    const registered: { provider: Monaco.languages.RenameProvider }[] = [];
    const monaco = {
      languages: {
        registerRenameProvider: (_id: string, provider: Monaco.languages.RenameProvider) => {
          registered.push({ provider });
          return { dispose: () => undefined };
        },
      },
      Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file:///${p}` }) },
    } as unknown as typeof Monaco;
    const handlers: ErbRenameHandlers = {
      canAnswer: () => true,
      currentIndex: () => ({ byName: new Map([['FOO', []]]) }) as unknown as ErbIndex,
      referencesTo: () => paths.flatMap(spansOf),
      isWritable: (p) => io.isWritable(p),
      openModelFor: () => undefined, // 全部按"未打开"处理 ⇒ 两边都走 io 通道
      applyToClosedFile: createApplyToClosedFile(io),
    };
    installErbRename(monaco, handlers);
    const model = {
      getLineCount: () => 3,
      getLineContent: (n: number) => text.split('\n')[n - 1] ?? '',
    } as unknown as Monaco.editor.ITextModel;
    return registered[0]!.provider.provideRenameEdits(model, { lineNumber: 2, column: 7 } as Monaco.Position, 'BAR', null as never);
  }

  it('全部可写 ⇒ 两条入口写出的字节逐字相同（同一命中集、同一条落盘通道）', async () => {
    const h = harness({ [A]: text, [B]: text }, [A, B]);
    const rename = await installRename(h.io, [A, B]);
    expect(rename && 'rejectReason' in rename ? rename.rejectReason : undefined).toBeUndefined();
    const renameBytes = new Map(h.files);

    const h2 = harness({ [A]: text, [B]: text }, [A, B]);
    const runner = createFileReplaceRunner({ io: h2.io, modelFor: () => undefined });
    const out = await runner(request([A, B], { query: 'FOO', replaceText: 'BAR' }));
    expect(out.applied).toBe(6);
    // 逐字节相同：两边都不许比对方多改或少改一个字符
    expect(h2.files).toEqual(new Map(renameBytes));
    expect(h2.files.get(A)).toBe('@BAR(1)\nCALL BAR\nSIF BAR() == 0\n');
  });

  it('含只读文件 ⇒ 两边同点名「1 个文件只读未纳入」，且 rename 整批取消 / replace 逐文件剔除', async () => {
    const h = harness({ [A]: text, [RO]: text }, [A]); // RO 只读
    const rename = await installRename(h.io, [A, RO]);
    expect(rename?.edits).toEqual([]);
    const renameReason = (rename && 'rejectReason' in rename ? rename.rejectReason : '') ?? '';
    expect(renameReason).toContain('1 个文件只读未纳入');
    expect(h.writes).toEqual([]); // 全或无：一份都没落

    const h2 = harness({ [A]: text, [RO]: text }, [A]);
    const runner = createFileReplaceRunner({
      io: h2.io,
      modelFor: () => undefined,
      nameLedger: (query) => (query === 'FOO' ? spansOf(B).map((s) => ({ ...s, language: 'erb' as const })) : []),
    });
    const out = await runner(request([A, RO], { query: 'FOO', replaceText: 'BAR' }));
    expect(out.readOnlyFiles).toBe(1);
    expect(out.errors.join('\n')).toContain('1 个文件只读未纳入');
    // 范围外残留由同一条判据说出来（两个写通道不再互不知情）
    expect(out.errors.join('\n')).toContain('检索范围外还有 3 处出现（1 个文件）');
  });
});

/* ============================== ③ 检索范围外的同名记号：说出来 ============================== */

describe('nameLedger（与 F2 判据互通）', () => {
  const ledger = (filePath: string): ReferenceOccurrence[] => [
    { filePath, line: 9, column: 3, endColumn: 6, kind: 'call', language: 'erb' },
  ];

  it('台账里有检索范围外的同名记号 ⇒ 结果里明示处数与文件数', async () => {
    const h = harness({ [A]: 'CALL FOO\n' }, [A, B]);
    const runner = createFileReplaceRunner({
      io: h.io,
      modelFor: () => undefined,
      nameLedger: () => [...ledger(A), ...ledger(B)], // B 不在 request.files 里
    });
    const out = await runner(request([A]));
    expect(out.applied).toBe(1);
    expect(out.errors.join('\n')).toContain('检索范围外还有 1 处出现（1 个文件）');
    expect(out.errors.join('\n')).toContain('FOO');
  });

  it('台账与检索集重合 ⇒ 不多嘴', async () => {
    const h = harness({ [A]: 'CALL FOO\n' }, [A]);
    const runner = createFileReplaceRunner({ io: h.io, modelFor: () => undefined, nameLedger: () => ledger(A) });
    const out = await runner(request([A]));
    expect(out.errors).toEqual([]);
  });

  it('判据抛错 ⇒ 可见但不影响已完成的替换', async () => {
    const h = harness({ [A]: 'CALL FOO\n' }, [A]);
    const runner = createFileReplaceRunner({
      io: h.io,
      modelFor: () => undefined,
      nameLedger: () => {
        throw new Error('索引未建');
      },
    });
    const out = await runner(request([A]));
    expect(out.applied).toBe(1);
    expect(out.errors.join('\n')).toContain('引用判据核对失败');
  });

  it('判据缺席 = 旧行为（零改动，不判、不多嘴）', async () => {
    const h = harness({ [A]: 'CALL FOO\n' }, [A]);
    const runner = createFileReplaceRunner({ io: h.io, modelFor: () => undefined });
    const out = await runner(request([A]));
    expect(out.errors).toEqual([]);
    expect(out.applied).toBe(1);
  });
});
