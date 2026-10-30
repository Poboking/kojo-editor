/**
 * ERB 改名**跨语言候选的范围**（ERB-PARITY G7）——钉「候选集合 = 可改集合」这一条不变式。
 *
 * ## 这一格修的是什么
 *
 * 候选源过去按 `isKojoSourcePath` 枚举（`.kojo` / `.kojo2` / `.kojo1` 三枚全收），
 * 判读却只认 v1 糖源（糖线 `resolveSugarTarget` 只认 `.kojo1`）：2.0 的源被列进候选
 * 却没人能判它的记号，于是
 * - 轻则"列得出、判不了"——糖线缺席 ⇒ 整批拒绝，作者为一个与本动作无关的 2.0 文件赔上整次改名；
 * - 重则按 2.0 的引用面改写 `.kojo`（那是 2.0 自己的命名空间，它有各自的引用 / 改名腿）。
 *
 * 修法：候选口径 = **转译产物的来源**（`ui/reference-utils.isSugarSourcePath`，扩展名清单取
 * 契约层 `KOJO_V1_SOURCE_EXTENSIONS`，与 `resolveSugarTarget` 同一枚常量）。本文件把两向都钉住：
 * 1. **候选 ⊆ 可改**：非 `.kojo1` 的源一条都不许出现在探针与编辑集里（2.0 的 `.kojo` /
 *    `.kojo2`、以及 `.erb` / `.md`）；
 * 2. **可改 ⊆ 候选**：输入里的每一份 `.kojo1`（已打开标签与宿主枚举两条腿，大小写不敏感）
 *    都被问到、一个不落——候选窄了但不许悄悄漏源。
 */

import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { type ErbIndex, type ErbReference } from '@kojo/plugin-api';
import { provideRename, provideRenameTarget } from '@kojo/plugin-erb-parser';
import { installErbRename, type ErbRenameHandlers } from '../src/monaco/erb-rename';
import { isKojoSourcePath, isSugarSourcePath } from '../src/ui/reference-utils';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';

const ERB_A = 'C:/p/ERB/a.ERB';
const NAME = 'M_KOJO_A';

/** 已开标签的假 model（`file:` uri + 各自的语言 id） */
function openModelOf(filePath: string, languageId: string, ...lines: string[]): Monaco.editor.ITextModel {
  return {
    uri: { scheme: 'file', fsPath: filePath, path: filePath, toString: () => `file:///${filePath}` },
    getLanguageId: () => languageId,
    getVersionId: () => 1,
    getValue: () => lines.join('\n'),
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (lineNumber: number, column: number): Monaco.Position => ({ lineNumber, column }) as Monaco.Position;

/** 方言闸（与插件供方同一枚判据） */
const isDialect = (path: string): boolean => /\.(?:erb|erh|erd)$/i.test(path);

function install(opts: {
  models?: Monaco.editor.ITextModel[];
  openModels?: ReadonlyMap<string, Monaco.editor.ITextModel>;
  kojoSources?: () => readonly { filePath: string; text: string }[];
  kojoReferences?: ErbRenameHandlers['kojoReferences'];
  probed?: string[];
  writable?: ReadonlySet<string>;
}) {
  const registered: Monaco.languages.RenameProvider[] = [];
  const stub = {
    languages: {
      registerRenameProvider: (_id: string, provider: Monaco.languages.RenameProvider) => {
        registered.push(provider);
        return { dispose: () => undefined };
      },
    },
    editor: { getModels: () => opts.models ?? [] },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file:///${p}` }) },
  } as unknown as typeof Monaco;
  const writable = opts.writable;
  // 收窄判据只看**候选范围**：写权限默认全开（本文件不测只读闸，那由 erb-rename.test.ts 钉）
  const isWritable = (p: string): boolean => (writable === undefined ? true : writable.has(p));
  // 判据桩：定义 / 调用都在 `a.ERB`（真判据 = 解析器插件）
  const refs: ErbReference[] = [
    { filePath: ERB_A, line: 1, column: 2, endColumn: 10, kind: 'definition' },
    { filePath: ERB_A, line: 2, column: 6, endColumn: 14, kind: 'call' },
  ];
  const index = {
    byName: new Map([[NAME, []]]),
    references: { bySymbol: new Map([[NAME, refs]]) },
  } as unknown as ErbIndex;
  const handlers: ErbRenameHandlers = {
    canAnswer: () => true,
    resolveTarget: (request) => provideRenameTarget(index, request, isDialect),
    resolveRename: (request) => provideRename(index, request, isDialect),
    isWritable,
    openModelFor: (p) => opts.openModels?.get(p),
    applyToClosedFile: async () => ({ applied: 0, stale: 0 }),
    ...(opts.kojoSources ? { kojoSources: opts.kojoSources } : {}),
    ...(opts.kojoReferences ? { kojoReferences: opts.kojoReferences } : {}),
  };
  installErbRename(stub, handlers);
  return registered[0]!;
}

describe('候选谓词：糖源 ≠ kojo 语言族（两枚判据各答各的）', () => {
  it('`isSugarSourcePath` 只认 v1 糖源（`.kojo1`，大小写不敏感）', () => {
    expect(isSugarSourcePath('C:/p/a.kojo1')).toBe(true);
    expect(isSugarSourcePath('C:/p/A.KOJO1')).toBe(true);
    expect(isSugarSourcePath('C:/p/a.kojo')).toBe(false);
    expect(isSugarSourcePath('C:/p/a.kojo2')).toBe(false);
    expect(isSugarSourcePath('C:/p/a.erb')).toBe(false);
  });

  it('`isKojoSourcePath`（台账语言轴）仍覆盖整个 kojo 语言族——两枚判据不要混用', () => {
    for (const p of ['C:/p/a.kojo', 'C:/p/a.kojo2', 'C:/p/a.kojo1']) expect(isKojoSourcePath(p)).toBe(true);
    expect(isKojoSourcePath('C:/p/a.erb')).toBe(false);
  });
});

describe('候选集合 = 可改集合（双向）', () => {
  const ERB_MODEL = openModelOf(ERB_A, ERB_LANGUAGE_ID, '@M_KOJO_A(1)', 'CALL M_KOJO_A');

  it('候选 ⊆ 可改：2.0 的 `.kojo` / `.kojo2` 不进探针、不进编辑集（无论已开标签还是宿主枚举）', async () => {
    const probed: string[] = [];
    const open1 = openModelOf('C:/p/kojo/open1.kojo1', KOJO_LANGUAGE_ID, `CALL ${NAME}()`);
    const provider = install({
      probed,
      models: [
        openModelOf('C:/p/kojo/open2.kojo', KOJO2_LANGUAGE_ID, `CALL ${NAME}()`),
        openModelOf('C:/p/kojo/open22.kojo2', KOJO2_LANGUAGE_ID, `CALL ${NAME}()`),
        open1,
      ],
      // 已开标签只认 v1 糖源那份（另外两份 2.0 即使开着也不进候选）
      openModels: new Map([
        [ERB_A, ERB_MODEL],
        ['C:/p/kojo/open1.kojo1', open1],
      ]),
      kojoSources: () => [
        { filePath: 'C:/p/kojo/disk2.kojo', text: `CALL ${NAME}()` },
        { filePath: 'C:/p/kojo/disk22.kojo2', text: `CALL ${NAME}()` },
        { filePath: 'C:/p/kojo/disk1.kojo1', text: `CALL ${NAME}()` },
      ],
      kojoReferences: ({ filePath }) => {
        probed.push(filePath);
        return [{ filePath, line: 1, column: 6, kind: 'call' }];
      },
    });
    const result = await provider.provideRenameEdits(ERB_MODEL, AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    // 2.0 一枚都没被问（"列得出、判不了"的那半边消失了）
    expect(probed.sort()).toEqual(['C:/p/kojo/disk1.kojo1', 'C:/p/kojo/open1.kojo1']);
    const files = ((result?.edits ?? []) as Monaco.languages.IWorkspaceTextEdit[])
      .map((e) => e.resource.toString())
      .sort();
    // 可改面 = ERB 文件（定义 + 调用两处）+ 那份 v1 糖源（2.0 的两份既没被问、也没进编辑集）
    expect(files).toEqual([`file:///C:/p/ERB/a.ERB`, `file:///C:/p/ERB/a.ERB`, 'file:///C:/p/kojo/open1.kojo1']);
  });

  it('可改 ⊆ 候选：每一份 v1 糖源都被问到（已开标签 / 宿主枚举 / 大小写变体，一个不落）', async () => {
    const probed: string[] = [];
    const provider = install({
      probed,
      models: [openModelOf('C:/p/kojo/open1.kojo1', KOJO_LANGUAGE_ID, `CALL ${NAME}()`)],
      kojoSources: () => [
        { filePath: 'C:/p/kojo/disk1.KOJO1', text: `CALL ${NAME}()` },
        { filePath: 'C:/p/kojo/disk2.kojo1', text: `CALL ${NAME}()` },
        // 没有同名记号的糖源不必问（判据答"与本动作无关"）
        { filePath: 'C:/p/kojo/other.kojo1', text: 'CALL SOMETHING_ELSE()' },
      ],
      kojoReferences: ({ filePath }) => {
        probed.push(filePath);
        return [];
      },
    });
    const result = await provider.provideRenameEdits(ERB_MODEL, AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    expect(probed.sort()).toEqual(['C:/p/kojo/disk1.KOJO1', 'C:/p/kojo/disk2.kojo1', 'C:/p/kojo/open1.kojo1']);
  });

  it('2.0 源里的同名记号不再拖累整次改名（判据缺席也不拒绝：它根本不进候选）', async () => {
    const probed: string[] = [];
    // 故意**不给** kojoReferences：若 2.0 源仍是候选，这里会走"不可证明 ⇒ 整批拒绝"
    const provider = install({
      kojoSources: () => [
        { filePath: 'C:/p/kojo/only2.kojo', text: `CALL ${NAME}()` },
        { filePath: 'C:/p/kojo/only22.kojo2', text: `CALL ${NAME}()` },
      ],
      openModels: new Map([[ERB_A, ERB_MODEL]]),
    });
    const result = await provider.provideRenameEdits(ERB_MODEL, AT(1, 3), 'NEW_A', null as never);
    expect(result && 'rejectReason' in result ? result.rejectReason : undefined).toBeUndefined();
    expect(probed).toEqual([]);
    expect((result?.edits ?? []).length).toBe(2); // ERB 那半边照改（定义 + 调用）
  });

  it('v1 糖源仍守全或无：`kojoReferences` 缺席 ⇒ 整批拒绝并点名（收窄没有拆掉安全闸）', async () => {
    const provider = install({
      kojoSources: () => [{ filePath: 'C:/p/kojo/hit.kojo1', text: `CALL ${NAME}()` }],
    });
    const result = await provider.provideRenameEdits(ERB_MODEL, AT(1, 3), 'NEW_A', null as never);
    expect(result?.edits).toEqual([]);
    const reason = (result && 'rejectReason' in result ? result.rejectReason : '') ?? '';
    expect(reason).toContain('hit.kojo1');
    expect(reason).toContain('整次重命名取消');
  });
});