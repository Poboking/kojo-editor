/**
 * 临时探针（取证用，交付前删除）。
 *
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest';
import type { EditorLanguageServiceContribution, ErbIndex, ErbReference } from '@kojo/plugin-api';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { declaredSlotKinds, descriptorForLanguageId } from '../src/monaco/language-registry';
import { installSlotServiceLegs } from '../src/monaco/slot-service-providers';
import { renameRequestOf } from '../src/monaco/kojo-language-service-legs';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';
import { kojo2PrepareRename } from '@kojo/kojo-lang/rename';
import { provideRename, provideRenameTarget } from '@kojo/plugin-erb-parser';

const isDialect = (p: string): boolean => /\.(?:erb|erh|erd)$/i.test(p);

function fakeMonaco(): {
  readonly monaco: typeof Monaco;
  readonly regs: { readonly selector: unknown; readonly provider: unknown }[];
} {
  const regs: { selector: unknown; provider: unknown }[] = [];
  const monaco = {
    languages: {
      registerRenameProvider: (selector: unknown, provider: unknown) => {
        regs.push({ selector, provider });
        return { dispose: () => undefined };
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file:///${p.replace(/\\/g, '/')}` }) },
  } as unknown as typeof Monaco;
  return { monaco, regs };
}

function modelAt(filePath: string, languageId: string, text: string): Monaco.editor.ITextModel {
  return {
    uri: {
      scheme: 'file',
      fsPath: filePath,
      path: filePath,
      toString: () => `file:///${filePath.replace(/\\/g, '/')}`,
    },
    getLanguageId: () => languageId,
    getVersionId: () => 1,
    getValue: () => text,
    getLineCount: () => text.split('\n').length,
    getLineContent: (n: number) => text.split('\n')[n - 1] ?? '',
    getOptions: () => ({ readOnly: false }),
    isDisposed: () => false,
  } as unknown as Monaco.editor.ITextModel;
}

const AT = (line: number, column: number) => ({ lineNumber: line, column }) as Monaco.Position;
const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const ERB_PATH = 'C:/p/ERB/a.ERB';
const ERB_TEXT = '@M_KOJO_A(1)\nCALL M_KOJO_A\nJUMP 1, $L1\n$L1\n';

const index = {
  byName: new Map([['M_KOJO_A', []]]),
  references: {
    bySymbol: new Map([
      [
        'M_KOJO_A',
        [
          { filePath: ERB_PATH, line: 1, column: 2, endColumn: 10, kind: 'definition' },
          { filePath: ERB_PATH, line: 2, column: 6, endColumn: 14, kind: 'call' },
          { filePath: 'C:/p/ERB/b.ERB', line: 7, column: 3, endColumn: 11, kind: 'call' },
        ] as ErbReference[],
      ],
    ]),
  },
} as unknown as ErbIndex;

function kernelAsking(
  contributions: readonly EditorLanguageServiceContribution[],
): { readonly calls: string[] } {
  const calls: string[] = [];
  setGlobalKernel({
    slots: { query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []) },
    project: { current: () => ({ adapterId: 'p' }) },
    io: { isWritable: () => true, readText: () => '', writeText: () => undefined },
  } as never);
  return { calls };
}

describe('探针 · rename 双挂', () => {
  it('A 挂载面 / 应答面', () => {
    const seen: string[] = [];
    kernelAsking([
      {
        id: 'probe-answer',
        provide: (request) => {
          seen.push(request.kind);
          return undefined;
        },
      } as unknown as EditorLanguageServiceContribution,
    ]);
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename']);
    console.log('PROBE-A 挂载 selector =', JSON.stringify(fake.regs.map((r) => String(r.selector))));
    const slot = fake.regs.find((r) => r.selector === ERB_LANGUAGE_ID)!.provider as Monaco.languages.RenameProvider;
    const model = modelAt(ERB_PATH, ERB_LANGUAGE_ID, ERB_TEXT);
    console.log('PROBE-A 槽腿 prepare(ERB) =', JSON.stringify(slot.resolveRenameLocation!(model, AT(2, 8), TOKEN)));
    console.log(
      'PROBE-A 槽腿 edits(ERB) =',
      JSON.stringify(slot.provideRenameEdits!(model, AT(2, 8), 'M_KOJO_B', TOKEN)),
    );
    console.log('PROBE-A 问槽的 kind =', JSON.stringify(seen));
    const kojo2 = fake.regs.find((r) => r.selector === KOJO2_LANGUAGE_ID)!.provider as Monaco.languages.RenameProvider;
    console.log(
      'PROBE-A 槽腿 prepare(kojo2) =',
      JSON.stringify(
        kojo2.resolveRenameLocation!(modelAt('D:/p/M.kojo', KOJO2_LANGUAGE_ID, '# 设 心情 整数 = 0'), AT(1, 6), TOKEN),
      ),
    );
    console.log(
      'PROBE-A descriptor：ERB =',
      JSON.stringify(declaredSlotKinds(descriptorForLanguageId(ERB_LANGUAGE_ID)!)),
      'kojo1 =',
      JSON.stringify(declaredSlotKinds(descriptorForLanguageId(KOJO_LANGUAGE_ID)!)),
    );
    expect(seen).toEqual([]);
  });

  it('B prepare 尺子对拍', () => {
    const cases: [string, number, number][] = [
      ['定义名 @M_KOJO_A', 1, 4],
      ['调用名 CALL M_KOJO_A', 2, 8],
      ['$ 标签 $L1', 4, 2],
    ];
    for (const [label, line, column] of cases) {
      const erb = provideRenameTarget(index, { path: ERB_PATH, text: ERB_TEXT, line, column }, isDialect);
      const k2 = kojo2PrepareRename(ERB_TEXT, { line, column });
      console.log(`PROBE-B ${label} (${line},${column}) ERB=`, JSON.stringify(erb), ' kojo2=', JSON.stringify(k2));
    }
  });

  it('C 闭文件落点 / related / 槽腿 WorkspaceEdit 形状', () => {
    const request = renameRequestOf(
      { path: ERB_PATH, languageId: ERB_LANGUAGE_ID, version: 1 },
      ERB_TEXT,
      2,
      8,
      'M_KOJO_B',
      { adapterId: 'p' } as never,
    );
    console.log('PROBE-C 槽腿 rename 请求键 =', JSON.stringify(Object.keys(request)));
    console.log('PROBE-C 供方（无 related）=', JSON.stringify(provideRename(index, request, isDialect)));
    console.log(
      'PROBE-C 供方（related.unprovable 在场）=',
      JSON.stringify(
        provideRename(index, { ...request, related: { unprovable: ['看不见 C:/p/kojo/A.kojo1'] } }, isDialect),
      ),
    );

    kernelAsking([
      {
        id: 'probe-xfile',
        provide: (r) =>
          r.kind === 'rename'
            ? {
                kind: 'rename',
                edits: [
                  { line: 2, startColumn: 6, endColumn: 14, newText: 'M_KOJO_B' },
                  { line: 7, startColumn: 3, endColumn: 11, newText: 'M_KOJO_B', resourcePath: 'C:/p/ERB/b.ERB' },
                ],
              }
            : undefined,
      } as unknown as EditorLanguageServiceContribution,
    ]);
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename']);
    const slot = fake.regs.find((r) => r.selector === KOJO2_LANGUAGE_ID)!.provider as Monaco.languages.RenameProvider;
    const out = slot.provideRenameEdits!(
      modelAt('D:/p/M.kojo', KOJO2_LANGUAGE_ID, '# 设 心情 整数 = 0\nCALL 心情\n'),
      AT(2, 6),
      'M_KOJO_B',
      TOKEN,
    ) as Monaco.languages.WorkspaceEdit & Monaco.languages.Rejection;
    console.log(
      'PROBE-C 槽腿交回 resource =',
      JSON.stringify((out.edits ?? []).map((e) => String((e as { resource: { toString(): string } }).resource))),
      'rejectReason =',
      out.rejectReason,
    );
    expect(vi.isMockFunction(() => undefined)).toBe(false);
  });
});
