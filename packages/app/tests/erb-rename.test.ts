/**
 * ERB 函数重命名（`erb-rename.ts`）单测——**不依赖真 Monaco**。
 *
 * 纯函数腿：词定位 / 名字命中与拒绝 / 编辑分组与只读剔除计数 / 全文改写（含陈旧跳过）。
 * Monaco 绑定腿：桩 monaco（只有 `registerRenameProvider` + `Uri.file`）+ 桩 model +
 * 桩 handlers，钉死三件行为契约：
 * (a) 索引未建 ⇒ `resolveRenameLocation` 返回 `undefined`（不报错），名字不认 ⇒ 带理由拒绝；
 * (b) 只读文件剔除计数进 `rejectReason`，且**全或无**——monaco 0.57 的 rename 控制器见到
 *     `rejectReason` 会丢弃全部编辑只弹 info，部分应用 = 静默半套重命名，禁；
 * (c) 已打开文件进 WorkspaceEdit（逐处 live 文本验证，陈旧坐标剔除）、未打开文件走 io 通道；
 * (d) **W8 XLANG-RENAME**：`.erb` 改名把糖线判为同名的 `.kojo` 记号并进同一批（同一条
 *     分组闸门与 io 通道）；判据缺席 ⇒ 整批拒绝并点名文件与处数；`.kojo` 只读并进同一个
 *     只读计数。派生预览 model（`inmemory://sugar/`）不参与。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { pathKey, type ErbIndex, type ErbReference } from '@kojo/plugin-api';
import {
  applyReferenceEdits,
  createApplyToClosedFile,
  installErbRename,
  type ErbRenameHandlers,
} from '../src/monaco/erb-rename';
// 判据本体（LAU-4 改名腿）：取词 / 名字判定 / 改名编排全在解析器插件，宿主只翻 Monaco 形状。
// 本文件的桩 handlers 直接把请求转给这几枚纯函数 ⇒ 断言测的仍是**真判据**（不是第二套假实现）。
import { provideRename, provideRenameTarget, resolveRenameName, wordAtColumn } from '@kojo/plugin-erb-parser';
import { planReferenceWrites, type ReferenceOccurrence } from '../src/ui/reference-utils';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';

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

describe('resolveRenameName', () => {
  const byName = new Map([
    ['M_KOJO_A', []],
    ['PRINT_FLAG', []],
  ]);
  const hasName = (name: string): boolean => byName.has(name);

  it('索引命中（大小写不敏感）⇒ 归一化名 + 原词区间', () => {
    const hit = resolveRenameName('@M_KOJO_A(ARG)', 4, hasName);
    expect(hit).toEqual({ kind: 'hit', startColumn: 2, endColumn: 10, normalizedName: 'M_KOJO_A' });
    const lower = resolveRenameName('CALL m_kojo_a()', 7, hasName);
    expect(lower).toEqual({ kind: 'hit', startColumn: 6, endColumn: 14, normalizedName: 'M_KOJO_A' });
  });

  it('`$` 标签 / `#DIM` 局部名 / 裸词不在索引 ⇒ 拒绝（不猜）', () => {
    const label = resolveRenameName('*PRINT_FLAG_2', 4, hasName); // 索引里只有 PRINT_FLAG
    expect(label.kind).toBe('reject');
    expect((label as { reason: string }).reason).toContain('PRINT_FLAG_2');
    const dim = resolveRenameName('#DIM LOCAL_NAME', 6, hasName);
    expect(dim.kind).toBe('reject');
    const bare = resolveRenameName('FOO = 1', 2, hasName);
    expect(bare.kind).toBe('reject');
  });

  it('光标处无词 ⇒ 拒绝（理由区分于"不在索引"）', () => {
    const none = resolveRenameName('A + B', 3, hasName);
    expect(none.kind).toBe('reject');
    expect((none as { reason: string }).reason).toContain('没有可重命名的名字');
  });
});

/* ============================== 纯函数：编辑分组与只读剔除 ============================== */

function ref(path: string, line: number, column: number, endColumn: number): ErbReference {
  return { filePath: path, line, column, endColumn, kind: 'call' };
}

/**
 * 编辑分组 / 只读剔除：宿主这一批**不再自建**分组器，直接用「全部替换」那份
 * `planReferenceWrites`（去重 + 按文件分组 + 只读按文件计）。本块钉住它在这条腿上的口径。
 */
describe('planReferenceWrites（改名写计划）', () => {
  function occ(path: string, line: number, column: number, endColumn: number): ReferenceOccurrence {
    return { filePath: path, line, column, endColumn, kind: 'call', language: 'erb' };
  }
  const refs = [
    occ('C:/p/ERB/a.ERB', 1, 2, 10), // definition
    occ('C:/p/ERB/b.ERB', 30, 6, 14),
    occ('C:/p/ERB/a.ERB', 88, 1, 9),
    occ('C:/p/ERH/x.ERH', 3, 2, 10),
  ];

  it('按文件分组、保持出现序；只读文件整文件剔除并计数（计文件数不是引用点数）', () => {
    const plan = planReferenceWrites(refs, (p) => p !== 'C:/p/ERH/x.ERH');
    expect(plan.readOnlyFiles).toEqual(['C:/p/ERH/x.ERH']);
    expect(plan.writable).toEqual([
      { path: 'C:/p/ERB/a.ERB', language: 'erb', occurrences: [refs[0], refs[2]] },
      { path: 'C:/p/ERB/b.ERB', language: 'erb', occurrences: [refs[1]] },
    ]);
  });

  it('全部可写 ⇒ 零剔除', () => {
    const plan = planReferenceWrites(refs, () => true);
    expect(plan.readOnlyFiles).toEqual([]);
    expect(plan.writable).toHaveLength(3);
  });

  it('全部只读 ⇒ 空组 + 全数', () => {
    const plan = planReferenceWrites(refs, () => false);
    expect(plan.readOnlyFiles).toHaveLength(3);
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
    // 请求模型必须带路径：宿主第一道闸是"这份视图有没有真文件"（标签腿要靠它查可写）
    uri: { fsPath: 'C:/p/ERB/a.ERB', toString: () => 'file:///C:/p/ERB/a.ERB' },
    getLanguageId: () => ERB_LANGUAGE_ID,
    getVersionId: () => 1,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

/**
 * **已打开标签**的假 model：带 `file:` uri（与真实 `Uri.file` 同形——`\` 归一成 `/`、
 * 盘符大小写原样保留）。重命名已开文件的 `resource` 必须取自这份 uri（而不是索引拼写），
 * 见 `erb-rename.ts` 的 `open.uri` 那条注释。
 */
function openModelOf(modelPath: string, ...lines: string[]): Monaco.editor.ITextModel {
  return {
    uri: { fsPath: modelPath, toString: () => `file:///${modelPath.replace(/\\/g, '/')}` },
    getLanguageId: () => ERB_LANGUAGE_ID,
    getVersionId: () => 1,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (lineNumber: number, column: number): Monaco.Position =>
  ({ lineNumber, column }) as Monaco.Position;

/** 方言闸（与插件供方同一枚判据；ERB 三种后缀） */
const isDialect = (path: string): boolean => /\.(?:erb|erh|erd)$/i.test(path);

/**
 * 桩 handlers：**判据直接转给解析器插件**（`provideRenameTarget` / `provideRename`），
 * 只把索引 / 引用集 / 写权限 / 已开标签表换成测试数据——断言因此测的是真判据。
 * `refs: null` ⇒ 反向引用索引缺席（`bySymbol` 不存在）。
 */
function handlersOfReal(opts: {
  byName?: ReadonlyMap<string, unknown>;
  refs?: readonly ErbReference[] | null;
  writable?: ReadonlySet<string>;
  openModels?: ReadonlyMap<string, Monaco.editor.ITextModel>;
  /** 显式索引（`null` = 索引未建） */
  index?: ErbIndex | null;
}): { handlers: ErbRenameHandlers; ioCalls: string[] } {
  const ioCalls: string[] = [];
  const byName = opts.byName ?? new Map([['M_KOJO_A', []]]);
  const refs = opts.refs ?? null;
  const writable = opts.writable ?? new Set<string>();
  const openModels = opts.openModels ?? new Map<string, Monaco.editor.ITextModel>();
  const index =
    opts.index !== undefined
      ? opts.index
      : ({
          byName,
          references: refs === null ? undefined : { bySymbol: new Map([['M_KOJO_A', refs]]) },
        } as unknown as ErbIndex);
  return {
    ioCalls,
    handlers: {
      canAnswer: () => true,
      resolveTarget: (request) => provideRenameTarget(index, request, isDialect),
      resolveRename: (request) => provideRename(index, request, isDialect),
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
  const OPEN_A = openModelOf(A, '@M_KOJO_A(1)', 'CALL M_KOJO_A');

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
      resolveTarget: () => undefined, // 无人应答（索引未建时插件的真实行为）
      resolveRename: () => undefined,
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

  it('ERB 词法 mention 调用形（名字后紧邻 "("）照改——`SIF FOO() == 0` 是真调用，与替换通道字节对拍不破', async () => {
    const A2 = openModelOf(A, '@M_KOJO_A(1)', 'SIF M_KOJO_A() == 0');
    const refs = [
      { filePath: A, line: 1, column: 2, endColumn: 10, kind: 'definition' } as ErbReference,
      { filePath: A, line: 2, column: 5, endColumn: 13, kind: 'mention' } as ErbReference,
    ];
    const wired = handlersOfReal({ refs, writable: new Set([A]), openModels: new Map([[A, A2]]) });
    const { provider } = installWith(wired);
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A'), AT(1, 3), 'M_KOJO_B', null as never);
    if (!result || !('edits' in result) || !result.edits) return expect.unreachable();
    expect(result.edits).toHaveLength(2); // 定义 + 条件位真调用都在
  });

  it('ERB 词法 mention 非调用形（未加引号输出行里的同名词）⇒ 跳过不落盘（「改名不重写散文」）', async () => {
    const A2 = openModelOf(A, '@M_KOJO_A(1)', 'PRINTFORML M_KOJO_A。');
    const refs = [
      { filePath: A, line: 1, column: 2, endColumn: 10, kind: 'definition' } as ErbReference,
      { filePath: A, line: 2, column: 12, endColumn: 20, kind: 'mention' } as ErbReference,
    ];
    const wired = handlersOfReal({ refs, writable: new Set([A]), openModels: new Map([[A, A2]]) });
    const { provider } = installWith(wired);
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A'), AT(1, 3), 'M_KOJO_B', null as never);
    if (!result || !('edits' in result) || !result.edits) return expect.unreachable();
    expect(result.edits).toHaveLength(1); // 只有定义点；台词位的 mention 被判据跳过
    const first = result.edits[0] as { textEdit: { range: { startLineNumber: number } } };
    expect(first.textEdit.range.startLineNumber).toBe(1);
  });

  it('全可写：已打开文件进 WorkspaceEdit（resource = live model 的 uri）、未打开走 io 通道', async () => {
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
    expect(edits[0]!.resource.toString()).toBe(OPEN_A.uri.toString()); // 就是那份 live model
    expect(edits[0]!.textEdit).toMatchObject({
      range: { startLineNumber: 1, startColumn: 2, endColumn: 10 },
      text: 'NEW_NAME',
    });
  });

  it('索引拼写 ≠ 标签建 model 的拼写 ⇒ resource 用解析到的 live uri（不发没人认领的 URI）', async () => {
    // 索引/搜索面给 `D:\p\ERB\a.ERB`，标签建立时那份是 `d:\p\erb\a.ERB`（盘符与大小写不同）：
    // 宿主 openModelFor 按 pathKey 找回 live model，但 `Uri.file(索引拼写)` 只归一分隔符、
    // 保留大小写 ⇒ URI 字符串与注册表里那份**不相等**，编辑发给一个没有 model 的 resource
    // （standalone 直接抛 `model not found`），开着且脏的标签静默漏改。
    const INDEX_A = 'D:\\p\\ERB\\a.ERB';
    const LIVE_A = 'd:\\p\\erb\\A.ERB'; // 同一个文件，另一种写法
    const openA = openModelOf(LIVE_A, '@M_KOJO_A(1)', 'CALL M_KOJO_A');
    const wired = handlersOfReal({ refs: [ref(INDEX_A, 1, 2, 10)], writable: new Set([INDEX_A]) });
    // 真实宿主判据（EditorPane 的 openModelAcrossGroups）：按 pathKey 找回那份 model
    wired.handlers.openModelFor = (p) => (pathKey(p) === pathKey(LIVE_A) ? openA : undefined);
    const { provider } = installWith(wired);
    const result = await provider.provideRenameEdits(modelOf('@M_KOJO_A(1)'), AT(1, 3), 'NEW_NAME', null as never);
    const edits = (result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[];
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    expect(edits).toHaveLength(1);
    expect(edits[0]!.resource.toString()).toBe(openA.uri.toString());
    expect(edits[0]!.resource.toString()).not.toBe(`file:///${INDEX_A.replace(/\\/g, '/')}`);
    expect(wired.ioCalls).toEqual([]); // 已开的文件不许走盘写通道
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

/* ============================== 跨语言腿（W8 XLANG-RENAME） ============================== */

/**
 * `.erb` 改名与生成它的 `.kojo` 源并成**一条写通道**（钉四件行为契约）：
 * ① 糖线判据证明的同名记号进同一批编辑（已开 → WorkspaceEdit、未开 → 同一条 io 通道）；
 * ② 判读缺席 ⇒ 整批拒绝 + 可读理由（绝不静默只改 `.erb` 那半边，下次保存会被冲掉）；
 * ③ `.kojo` 只读文件并入**同一个**只读计数（同一次全或无）；
 * ④ 落盘通道 `createApplyToClosedFile` 的三步纪律（只读先闸 / 现文本验证 / 零改动不写）。
 */

const K = 'C:/p/kojo/A.kojo';
const K2 = 'C:/p/kojo/B.kojo';

/** `.kojo` 源 model（真文件 model：scheme = file；糖预览 model 是 inmemory，不参与） */
function kojoModelOf(filePath: string, ...lines: string[]): Monaco.editor.ITextModel {
  return {
    uri: {
      scheme: 'file',
      fsPath: filePath,
      path: filePath,
      toString: () => `file:///${filePath.replace(/\\/g, '/')}`,
    },
    getLanguageId: () => KOJO_LANGUAGE_ID,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

/** 带 `editor.getModels()` 的 monaco 桩（已开 `.kojo` 标签的枚举面） */
function stubMonacoWithModels(models: Monaco.editor.ITextModel[]) {
  const registered: { languageId: string; provider: Monaco.languages.RenameProvider }[] = [];
  const monaco = {
    languages: {
      registerRenameProvider: (languageId: string, provider: Monaco.languages.RenameProvider) => {
        registered.push({ languageId, provider });
        return { dispose: () => undefined };
      },
    },
    editor: { getModels: () => models },
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file:///${p.replace(/\\/g, '/')}` }),
    },
  } as unknown as typeof Monaco;
  return { monaco, provider: () => registered[0]!.provider };
}

/**
 * 光标命中 `M_KOJO_A` 的 `.erb` 定义 model。
 * 它同时是 `A` 的**已开标签**（`openModels` 里那份），所以必须带 `file:` uri——
 * `WorkspaceEdit` 的 `resource` 取自 live model 的 uri（真实 Monaco model 必有 uri）。
 */
const ERB_DEF_MODEL = () => openModelOf('C:/p/ERB/a.ERB', '@M_KOJO_A(1)', 'CALL M_KOJO_A');

function kojoHandlers(opts: {
  refs: readonly ErbReference[];
  writable: ReadonlySet<string>;
  openModels?: ReadonlyMap<string, Monaco.editor.ITextModel>;
  models?: Monaco.editor.ITextModel[];
  kojoSources?: (
    name: string,
  ) => readonly { filePath: string; text: string }[] | Promise<readonly { filePath: string; text: string }[]>;
  kojoReferences?: NonNullable<ErbRenameHandlers['kojoReferences']>;
  applyToClosedFile?: ErbRenameHandlers['applyToClosedFile'];
}) {
  const ioCalls: string[] = [];
  // 判据桩：byName 命中 = 可改名；反向索引把测试引用集挂在 `M_KOJO_A` 名下
  const index = {
    byName: new Map([['M_KOJO_A', []]]),
    references: { bySymbol: new Map([['M_KOJO_A', opts.refs]]) },
  } as unknown as ErbIndex;
  const handlers: ErbRenameHandlers = {
    canAnswer: () => true,
    resolveTarget: (request) => provideRenameTarget(index, request, isDialect),
    resolveRename: (request) => provideRename(index, request, isDialect),
    isWritable: (p) => opts.writable.has(p),
    openModelFor: (p) => opts.openModels?.get(p),
    applyToClosedFile:
      opts.applyToClosedFile ??
      (async (p) => {
        ioCalls.push(p);
        return { applied: 1, stale: 0 };
      }),
    ...(opts.kojoSources ? { kojoSources: opts.kojoSources } : {}),
    ...(opts.kojoReferences ? { kojoReferences: opts.kojoReferences } : {}),
  };
  const stub = stubMonacoWithModels(opts.models ?? []);
  installErbRename(stub.monaco, handlers);
  return { ioCalls, provider: stub.provider(), handlers };
}

describe('erb-rename 跨语言腿（.kojo 源）', () => {
  const A = 'C:/p/ERB/a.ERB';
  const erbRefs = [ref(A, 1, 2, 10)];

  it('① 糖线证明的 .kojo 记号进同一批编辑（已开标签走 WorkspaceEdit）', async () => {
    const kojoModel = kojoModelOf(K, '调用 M_KOJO_A()', 'PRINT M_KOJO_A');
    const { provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A, K]),
      openModels: new Map([[A, ERB_DEF_MODEL()], [K, kojoModel]]),
      models: [kojoModel],
      kojoReferences: ({ filePath, text }) => {
        expect(filePath).toBe(K);
        expect(text).toContain('M_KOJO_A');
        return [
          { filePath, line: 1, column: 4, kind: 'call' },
          { filePath, line: 2, column: 7, kind: 'mention' },
        ];
      },
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    const edits = (result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[];
    // 定义处 + .kojo 源两处 = 三处，一次交付
    expect(edits).toHaveLength(3);
    const kojoEdits = edits.filter((e) => e.resource.toString().includes('A.kojo'));
    expect(kojoEdits.map((e) => [e.textEdit.range.startLineNumber, e.textEdit.range.startColumn])).toEqual([
      [1, 4],
      [2, 7],
    ]);
    expect(kojoEdits.every((e) => e.textEdit.text === 'NEW_A')).toBe(true);
  });

  it('①b 未打开的 .kojo 源走同一条 io 通道（宿主枚举补齐判读）', async () => {
    const { ioCalls, provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A, K2]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      kojoSources: () => [{ filePath: K2, text: '调用 M_KOJO_A()\n' }],
      kojoReferences: ({ filePath }) => [{ filePath, line: 1, column: 4, kind: 'call' }],
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    expect(ioCalls).toEqual([K2]); // 未开标签 ⇒ io 通道（与 .erb 同一入口）
  });

  it('② 判据缺席 ⇒ 整批拒绝，理由点名 .kojo 文件与处数（不静默改一半）', async () => {
    const kojoModel = kojoModelOf(K, '调用 M_KOJO_A()', '; 散文里也写 M_KOJO_A');
    const { ioCalls, provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A, K]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      models: [kojoModel],
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result?.edits).toEqual([]);
    expect(ioCalls).toEqual([]); // 一份都没落
    const reason = (result && 'rejectReason' in result ? result.rejectReason : '') ?? '';
    expect(reason).toContain('.kojo');
    expect(reason).toContain('2 处');
    expect(reason).toContain('整次重命名取消');
  });

  it('②b 糖线判读**抛错**（不是"答没有引用"）⇒ 同样整批拒绝，绝不静默只改 .erb', async () => {
    const kojoModel = kojoModelOf(K, '调用 M_KOJO_A()', 'PRINT M_KOJO_A');
    const { ioCalls, provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A, K]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      models: [kojoModel],
      kojoReferences: () => {
        throw new Error('转译器探针未就绪');
      },
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result?.edits).toEqual([]);
    expect(ioCalls).toEqual([]); // 一份都没落（含 .erb 那半边）
    const reason = (result && 'rejectReason' in result ? result.rejectReason : '') ?? '';
    expect(reason).toContain('2 处');
    expect(reason).toContain('转译器探针未就绪');
    expect(reason).toContain('整次重命名取消');
  });

  it('②c 宿主 .kojo 源枚举**抛错**（未打开的糖源看不见）⇒ 无从证明 ⇒ 整批拒绝', async () => {
    const { ioCalls, provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      kojoSources: () => {
        throw new Error('walkDir 取消');
      },
      kojoReferences: ({ filePath }) => [{ filePath, line: 1, column: 4, kind: 'call' }],
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result?.edits).toEqual([]);
    expect(ioCalls).toEqual([]);
    const reason = (result && 'rejectReason' in result ? result.rejectReason : '') ?? '';
    expect(reason).toContain('walkDir 取消');
    expect(reason).toContain('.kojo');
  });

  it('③ .kojo 只读 ⇒ 并入同一个只读计数，整次取消（两种语言一份闸门）', async () => {
    const kojoModel = kojoModelOf(K, '调用 M_KOJO_A()');
    const { provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A]), // K 只读
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      models: [kojoModel],
      kojoReferences: ({ filePath }) => [{ filePath, line: 1, column: 4, kind: 'call' }],
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result?.edits).toEqual([]);
    expect(result && 'rejectReason' in result ? result.rejectReason : '').toContain('1 个文件只读未纳入');
  });

  it('糖线判"不是函数引用"（空集）⇒ .kojo 一侧不动、.erb 一侧照改', async () => {
    const kojoModel = kojoModelOf(K, '台词旁白：M_KOJO_A 是散文');
    const { provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A, K]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      models: [kojoModel],
      kojoReferences: () => [],
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    const edits = (result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[];
    expect(edits).toHaveLength(1);
    expect(edits[0]!.resource.toString()).toContain('a.ERB');
  });

  it('派生预览 model（inmemory://sugar/）不参与跨语言腿', async () => {
    const derived = {
      ...kojoModelOf(K, '调用 M_KOJO_A()'),
      uri: { scheme: 'inmemory', fsPath: '', path: '/sugar/A.kojo', toString: () => 'inmemory://sugar/A.kojo' },
    } as unknown as Monaco.editor.ITextModel;
    const { provider } = kojoHandlers({
      refs: erbRefs,
      writable: new Set([A]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      models: [derived],
    });
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
  });
});

/* ============================== 全或无的第二道闸：rejectReason 与已落盘永不同时 ============================== */

/**
 * monaco 0.57 standalone 的 rename 控制器见 `rejectReason` 会**丢弃全部 WorkspaceEdit**
 * （只弹 info）。于是"盘上已经写了几个闭文件"与"返回 rejectReason"绝不能同时出现——
 * 同时出现 = 盘上半套 + 标签没改，作者拿到的就是名字分叉的半成品还不自知。
 * io 失败的两种现场各钉一条：一处都没落 ⇒ 真拒绝；已有落点 ⇒ 不拒绝，交付其余。
 */
describe('erb-rename 写入失败的全或无不变式', () => {
  const A = 'C:/p/ERB/a.ERB';
  const B = 'C:/p/ERB/b.ERB';
  const C = 'C:/p/ERB/c.ERB';

  function installWithIo(io: ErbRenameHandlers['applyToClosedFile'], refs: readonly ErbReference[]) {
    return kojoHandlers({
      refs,
      writable: new Set([A, B, C]),
      openModels: new Map([[A, ERB_DEF_MODEL()]]),
      applyToClosedFile: io,
    });
  }

  it('一处闭文件都没落 ⇒ 带理由拒绝，编辑集清空（不留"标签没改盘上改了一半"）', async () => {
    const { provider } = installWithIo(
      async (p) => {
        throw new Error(`写允许域未批准：${p}`);
      },
      [ref(A, 1, 2, 10), ref(B, 5, 1, 9), ref(C, 7, 1, 9)],
    );
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(result?.edits).toEqual([]); // a.ERB 的 live 编辑一并交出（控制器丢弃 = 全不动）
    const reason = (result && 'rejectReason' in result ? result.rejectReason : '') ?? '';
    expect(reason).toContain('整次重命名取消');
    expect(reason).toContain('写允许域未批准');
  });

  it('已有闭文件落盘后再失败 ⇒ 绝不返回 rejectReason（拒绝与部分成功不共存）', async () => {
    let landed = 0;
    const { provider } = installWithIo(
      async (p) => {
        if (p === B) {
          landed++;
          return { applied: 1, stale: 0 };
        }
        throw new Error(`磁盘写入中断：${p}`);
      },
      [ref(A, 1, 2, 10), ref(B, 5, 1, 9), ref(C, 7, 1, 9)],
    );
    const result = await provider.provideRenameEdits(ERB_DEF_MODEL(), AT(1, 3), 'NEW_A', null as never);
    expect(landed).toBe(1); // 盘上确实有改动
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    const edits = (result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[];
    expect(edits).toHaveLength(1); // 已开标签这一处照常交付 = 把能补的落点补齐
    expect(edits[0]!.textEdit.text).toBe('NEW_A');
  });
});

/* ============================== 闭文件通道（与「全部替换」同源） ============================== */

describe('createApplyToClosedFile', () => {
  const apply = createApplyToClosedFile;

  it('读 → 现文本验证 → 有实改才写回（陈旧处计 stale）', async () => {
    const files = new Map<string, string>([['p', 'CALL FOO\nGONE\n']]);
    const io = {
      isWritable: () => true,
      readText: async (p: string) => ({ text: files.get(p)! }),
      writeText: async (p: string, text: string) => void files.set(p, text),
    };
    const out = await apply(io)('p', [{ line: 1, column: 6, endColumn: 9 }, { line: 2, column: 1, endColumn: 4 }], 'BAR', 'FOO');
    expect(out).toEqual({ applied: 1, stale: 1 });
    expect(files.get('p')).toBe('CALL BAR\nGONE\n');
  });

  it('只读文件先被闸门挡下：一次读盘都不发生（不绕写允许域）', async () => {
    let reads = 0;
    const io = {
      isWritable: () => false,
      readText: async () => {
        reads++;
        return { text: '' };
      },
      writeText: async () => undefined,
    };
    await expect(apply(io)('p', [{ line: 1, column: 1, endColumn: 4 }], 'BAR', 'FOO')).rejects.toThrow(/只读/);
    expect(reads).toBe(0);
  });

  it('一处都没改 ⇒ 不写盘（零备份、零脏文件）', async () => {
    let writes = 0;
    const io = {
      isWritable: () => true,
      readText: async () => ({ text: 'CALL OTHER\n' }),
      writeText: async () => void writes++,
    };
    const out = await apply(io)('p', [{ line: 1, column: 6, endColumn: 9 }], 'BAR', 'FOO');
    expect(out).toEqual({ applied: 0, stale: 1 });
    expect(writes).toBe(0);
  });
});
