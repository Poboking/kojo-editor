/**
 * ERB 函数重命名（`erb-rename.ts`）单测——**不依赖真 Monaco**。
 *
 * 纯函数腿：词定位 / 名字命中与拒绝 / 编辑分组与只读剔除计数 / 全文改写（含陈旧跳过）。
 * Monaco 绑定腿：桩 monaco（只有 `registerRenameProvider` + `Uri.file`）+ 桩 model +
 * 桩 handlers，钉死三件行为契约：
 * (a) 索引未建 ⇒ `resolveRenameLocation` 返回 `undefined`（不报错），名字不认 ⇒ 带理由拒绝；
 * (b) 只读文件剔除计数进 `rejectReason`，且**全或无**——monaco 0.57 的 rename 控制器见到
 *     `rejectReason` 会丢弃全部编辑只弹 info，部分应用 = 静默半套重命名，禁；
 * (c) 已打开文件进 WorkspaceEdit（逐处 live 文本验证，陈旧坐标剔除）、未打开文件走 io 通道。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import type { ErbReference } from '@kojo/plugin-api';
import {
  applyReferenceEdits,
  installErbRename,
  planRenameEdits,
  resolveRenameTarget,
  wordAtColumn,
  type ErbRenameHandlers,
} from '../src/monaco/erb-rename';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';

/* ============================== 纯函数：词定位 ============================== */

describe('wordAtColumn', () => {
  it('词中 / 词尾后一格 / 词首都命中同一区间', () => {
    const line = 'CALL FOO_BAR';
    // FOO_BAR 占 0 基 [5, 12)
    expect(wordAtColumn(line, 5)).toEqual({ start: 5, end: 12 });
    expect(wordAtColumn(line, 11)).toEqual({ start: 5, end: 12 });
    expect(wordAtColumn(line, 12)).toEqual({ start: 5, end: 12 }); // 词尾后一格仍在词上
    expect(wordAtColumn(line, 6)).toEqual({ start: 5, end: 12 });
  });

  it('词中 / 词尾后一格 / 词首上一格都命中同一区间', () => {
    const line = 'CALL FOO_BAR';
    // FOO_BAR 占 0 基 [5, 12)
    expect(wordAtColumn(line, 5)).toEqual({ start: 5, end: 12 });
    expect(wordAtColumn(line, 11)).toEqual({ start: 5, end: 12 });
    expect(wordAtColumn(line, 12)).toEqual({ start: 5, end: 12 }); // 词尾后一格仍在词上
    expect(wordAtColumn(line, 6)).toEqual({ start: 5, end: 12 });
    expect(wordAtColumn(line, 3)).toEqual({ start: 0, end: 4 }); // 前一个词的词尾同理
  });

  it('两侧都不是标识字符才算无词', () => {
    expect(wordAtColumn('A + B', 2)).toBeNull(); // + 两侧都是空白
    expect(wordAtColumn('  LOCAL', 0)).toBeNull();
    expect(wordAtColumn('', 0)).toBeNull();
    expect(wordAtColumn('FOO', -1)).toBeNull();
  });

  it('CJK 函数名与 ASCII 连成一词', () => {
    const line = '@ cloth_着替え処理(ARG)';
    const start = line.indexOf('cloth_');
    expect(wordAtColumn(line, line.indexOf('着替え処理') + 1)).toEqual({
      start,
      end: start + 'cloth_着替え処理'.length,
    });
  });

  it('越界列夹取到行尾（贴着词尾算在词上）', () => {
    expect(wordAtColumn('FOO', 99)).toEqual({ start: 0, end: 3 });
  });
});

/* ============================== 纯函数：名字判定 ============================== */

describe('resolveRenameTarget', () => {
  const byName = new Map([
    ['M_KOJO_A', []],
    ['PRINT_FLAG', []],
  ]);

  it('索引命中（大小写不敏感）⇒ 归一化名 + 原词区间', () => {
    const hit = resolveRenameTarget('@M_KOJO_A(ARG)', 4, byName);
    expect(hit).toEqual({ kind: 'hit', startColumn: 2, endColumn: 10, normalizedName: 'M_KOJO_A' });
    const lower = resolveRenameTarget('CALL m_kojo_a()', 7, byName);
    expect(lower).toEqual({ kind: 'hit', startColumn: 6, endColumn: 14, normalizedName: 'M_KOJO_A' });
  });

  it('`$` 标签 / `#DIM` 局部名 / 裸词不在索引 ⇒ 拒绝（不猜）', () => {
    const label = resolveRenameTarget('*PRINT_FLAG_2', 4, byName); // 索引里只有 PRINT_FLAG
    expect(label.kind).toBe('reject');
    expect((label as { reason: string }).reason).toContain('PRINT_FLAG_2');
    const dim = resolveRenameTarget('#DIM LOCAL_NAME', 6, byName);
    expect(dim.kind).toBe('reject');
    const bare = resolveRenameTarget('FOO = 1', 2, byName);
    expect(bare.kind).toBe('reject');
  });

  it('光标处无词 ⇒ 拒绝（理由区分于"不在索引"）', () => {
    const none = resolveRenameTarget('A + B', 3, byName);
    expect(none.kind).toBe('reject');
    expect((none as { reason: string }).reason).toContain('没有可重命名的名字');
  });
});

/* ============================== 纯函数：编辑分组与只读剔除 ============================== */

function ref(path: string, line: number, column: number, endColumn: number): ErbReference {
  return { filePath: path, line, column, endColumn, kind: 'call' };
}

describe('planRenameEdits', () => {
  const refs = [
    ref('C:/p/ERB/a.ERB', 1, 2, 10), // definition
    ref('C:/p/ERB/b.ERB', 30, 6, 14),
    ref('C:/p/ERB/a.ERB', 88, 1, 9),
    ref('C:/p/ERH/x.ERH', 3, 2, 10),
  ];

  it('按文件分组、保持出现序；只读文件整文件剔除并计数（计文件数不是引用点数）', () => {
    const plan = planRenameEdits(refs, (p) => p !== 'C:/p/ERH/x.ERH');
    expect(plan.readOnlyCount).toBe(1);
    expect(plan.writable).toEqual([
      { path: 'C:/p/ERB/a.ERB', refs: [refs[0], refs[2]] },
      { path: 'C:/p/ERB/b.ERB', refs: [refs[1]] },
    ]);
  });

  it('全部可写 ⇒ 零剔除', () => {
    const plan = planRenameEdits(refs, () => true);
    expect(plan.readOnlyCount).toBe(0);
    expect(plan.writable).toHaveLength(3);
  });

  it('全部只读 ⇒ 空组 + 全数', () => {
    const plan = planRenameEdits(refs, () => false);
    expect(plan.readOnlyCount).toBe(3);
    expect(plan.writable).toEqual([]);
  });
});

/* ============================== 纯函数：全文改写 ============================== */

describe('applyReferenceEdits', () => {
  it('多行多处替换，applied 计数正确', () => {
    const text = '@FOO(1)\nCALL FOO\nSIF FOO() == 0\n';
    const refs = [
      ref('p', 1, 2, 5),
      ref('p', 2, 6, 9),
      ref('p', 3, 5, 8),
    ];
    const out = applyReferenceEdits(text, refs, 'BAR', 'FOO');
    expect(out.text).toBe('@BAR(1)\nCALL BAR\nSIF BAR() == 0\n');
    expect(out.applied).toBe(3);
    expect(out.stale).toBe(0);
  });

  it('保 \\r\\n 换行', () => {
    const text = '@FOO\r\nCALL FOO\r\n';
    const out = applyReferenceEdits(text, [ref('p', 1, 2, 5), ref('p', 2, 6, 9)], 'BAR', 'FOO');
    expect(out.text).toBe('@BAR\r\nCALL BAR\r\n');
  });

  it('现文本大小写不敏感匹配（索引归一口径）', () => {
    const out = applyReferenceEdits('@foo\n', [ref('p', 1, 2, 5)], 'BAR', 'FOO');
    expect(out.text).toBe('@BAR\n');
    expect(out.applied).toBe(1);
  });

  it('陈旧索引不哑替换：文本不匹配 / 行越界 ⇒ stale 计数跳过', () => {
    const text = 'CALL FOO\nLOCAL = FOO(1)\n';
    // 第 2 处列区间上是 LOCAL（作者已改写）；第 3 处行号越界
    const refs = [ref('p', 1, 6, 9), ref('p', 2, 1, 6), ref('p', 9, 1, 4)];
    const out = applyReferenceEdits(text, refs, 'BAR', 'FOO');
    expect(out.text).toBe('CALL BAR\nLOCAL = FOO(1)\n');
    expect(out.applied).toBe(1);
    expect(out.stale).toBe(2);
  });
});

/* ============================== Monaco 绑定腿（桩） ============================== */

interface Stub {
  registered: { languageId: string; provider: Monaco.languages.RenameProvider }[];
  monaco: typeof Monaco;
}

function stubMonaco(): Stub {
  const registered: Stub['registered'] = [];
  const monaco = {
    languages: {
      registerRenameProvider: (languageId: string, provider: Monaco.languages.RenameProvider) => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    Uri: {
      file: (p: string) => ({ fsPath: p, toString: () => `file:///${p.replace(/\\/g, '/')}` }),
    },
  } as unknown as typeof Monaco;
  return { registered, monaco };
}

function modelOf(...lines: string[]): Monaco.editor.ITextModel {
  return {
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as Monaco.Position;

/** 桩 handlers：固定索引 / 引用 / 可写表；记录 io 通道调用 */
function handlersOfReal(opts: {
  byName?: ReadonlyMap<string, unknown>;
  refs?: readonly ErbReference[] | null;
  writable?: ReadonlySet<string>;
  openModels?: ReadonlyMap<string, Monaco.editor.ITextModel>;
}): { handlers: ErbRenameHandlers; ioCalls: string[] } {
  const ioCalls: string[] = [];
  const byName = opts.byName ?? new Map([['M_KOJO_A', []]]);
  const refs = opts.refs ?? null;
  const writable = opts.writable ?? new Set<string>();
  const openModels = opts.openModels ?? new Map();
  return {
    ioCalls,
    handlers: {
      canAnswer: () => true,
      currentIndex: () =>
        ({
          byName,
          references: { bySymbol: new Map() },
        }) as unknown as import('@kojo/plugin-api').ErbIndex,
      referencesTo: () => refs,
      isWritable: (p) => writable.has(p),
      openModelFor: (p) => openModels.get(p),
      applyToClosedFile: async (p) => {
        ioCalls.push(p);
        return { applied: 1, stale: 0 };
      },
    },
  };
}

describe('installErbRename', () => {
  const A = 'C:/p/ERB/a.ERB';
  const B = 'C:/p/ERB/b.ERB';
  const A_REFS = [ref(A, 1, 2, 10), ref(B, 5, 1, 9)];
  const OPEN_A = modelOf('@M_KOJO_A(1)', 'CALL M_KOJO_A');

  function installWith(o: ReturnType<typeof handlersOfReal>): { stub: Stub; provider: Monaco.languages.RenameProvider } {
    const stub = stubMonaco();
    const disposable = installErbRename(stub.monaco, o.handlers);
    expect(stub.registered).toHaveLength(1);
    expect(stub.registered[0]!.languageId).toBe(ERB_LANGUAGE_ID);
    void disposable;
    return { stub, provider: stub.registered[0]!.provider };
  }

  it('索引未建 ⇒ resolveRenameLocation 返回 undefined（不报错）', async () => {
    const stub2 = stubMonaco();
    installErbRename(stub2.monaco, {
      canAnswer: () => true,
      currentIndex: () => null,
      referencesTo: () => null,
      isWritable: () => true,
      openModelFor: () => undefined,
      applyToClosedFile: async () => ({ applied: 0, stale: 0 }),
    });
    const p2 = stub2.registered[0]!.provider;
    expect(p2.resolveRenameLocation!(modelOf('@M_KOJO_A'), AT(1, 3), null as never)).toBeUndefined();
  });

  it('名字不在索引 ⇒ 带理由拒绝；命中 ⇒ RenameLocation（原词 + 区间）', async () => {
    const { provider } = installWith(handlersOfReal({ refs: A_REFS, writable: new Set([A, B]), openModels: new Map([[A, OPEN_A]]) }));
    const miss = await provider.resolveRenameLocation!(modelOf('*PRINT_FLAG_2'), AT(1, 5), null as never);
    expect(miss && 'rejectReason' in miss ? miss.rejectReason : undefined).toContain('PRINT_FLAG_2');
    const hit = await provider.resolveRenameLocation!(modelOf('@M_KOJO_A(1)'), AT(1, 3), null as never);
    expect(hit).toMatchObject({
      text: 'M_KOJO_A',
      range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 10 },
    });
  });

  it('只读文件 ⇒ 编辑集清空 + rejectReason 明示 n 个文件只读未纳入（全或无）', async () => {
    const { provider } = installWith(handlersOfReal({ refs: A_REFS, writable: new Set([A]) })); // B 只读
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A'), AT(1, 3), 'NEW_NAME', null as never);
    expect(result?.edits).toEqual([]);
    expect(result && 'rejectReason' in result ? result.rejectReason : '').toContain('1 个文件只读未纳入');
  });

  it('全可写：已打开文件进 WorkspaceEdit（resource = Uri.file）、未打开走 io 通道', async () => {
    const wired = handlersOfReal({
      refs: A_REFS,
      writable: new Set([A, B]),
      openModels: new Map([[A, OPEN_A]]),
    });
    const { provider } = installWith(wired);
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A'), AT(1, 3), 'NEW_NAME', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    expect(wired.ioCalls).toEqual([B]); // b.ERB 未打开 ⇒ io 通道
    const edits = (result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[];
    expect(edits).toHaveLength(1); // a.ERB 已打开且 1 处 live 命中
    expect(edits[0]!.resource.toString()).toContain('ERB/a.ERB');
    expect(edits[0]!.textEdit).toMatchObject({
      range: { startLineNumber: 1, startColumn: 2, endColumn: 10 },
      text: 'NEW_NAME',
    });
  });

  it('已打开文件上陈旧引用（live 文本不匹配）剔除出编辑集，不硬写', async () => {
    // 索引说 a.ERB:2:1-5 是引用，但 live model 第二行已是别的文本；定义处仍匹配
    const wired = handlersOfReal({
      refs: [ref(A, 1, 2, 10), ref(A, 2, 1, 5)],
      writable: new Set([A]),
      openModels: new Map([[A, OPEN_A]]),
    });
    const { provider } = installWith(wired);
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A(1)', 'GONE'), AT(1, 3), 'NEW_NAME', null as never);
    const edits = (result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[];
    expect(edits).toHaveLength(1); // 只有定义处进编辑集
    expect(edits[0]!.textEdit.range).toMatchObject({ startLineNumber: 1, startColumn: 2 });
  });

  it('反向引用索引缺席（referencesTo = null）⇒ 拒绝且不部分改', async () => {
    const wired = handlersOfReal({ refs: null, writable: new Set([A, B]) });
    const { provider } = installWith(wired);
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A'), AT(1, 3), 'NEW_NAME', null as never);
    expect(result?.edits).toEqual([]);
    expect(result && 'rejectReason' in result ? result.rejectReason : '').toContain('反向引用索引缺席');
    expect(wired.ioCalls).toEqual([]);
  });
});
