/**
 * LAU-DUALLEG · `rename` 这一 kind 的「谁在答」行为闸（第十波，2026-10-31）。
 *
 * ## 这格从哪来
 *
 * 上一波触顶车（`origin/b/lead9/rename-dualleg`）只留下一枚 `tests/zz-probe-rename-dualleg.test.ts`
 * 取证探针（全是 `console.log`，没有一条判据，且 `zz-` 前缀是残骸）。本车把它**转成正式判据**
 * 并并入改名族：探针问过的三件事（挂载面 / 两把 prepare 尺子 / 闭文件回写通道）在这里全部
 * 变成会红的 `expect`，读数逐字取自本车实跑。注册面与装配面的计数判据在
 * `language-parity.test.ts` 的 `DOUBLE-LEG-1032C` 那一组（同款形状，两族各钉自己的面）。
 *
 * ## 判定的三条实情（本文件钉的就是这三条）
 *
 * 1. **挂载面双挂、应答面单答**：`SLOT_SERVICE_LEGS` 里**有** `rename` 这枚腿（不同于
 *    `definition` / `implementation` 那两格），它经 `registerForLanguageServices(… , leg.kind)`
 *    铺到「旧桥语言 + 点名 rename 的语言」= `kojo-erb` / `kojo-legacy` / `kojo2` 三枚 id 上，
 *    而 ERB 与 kojo1 各自还挂着一枚宿主腿（`monaco/erb-rename.ts` / `monaco/kojo-rename.ts`）
 *    ⇒ 一枚 model 上两枚同种 provider。今天不出事**只因为**槽腿对这两门恒弃权
 *    （`servesSlotOf(model,'rename')` 读 descriptor 的点名表——双挂车 1 之后 ERB 点名了六格，
 *    里面**没有** `rename`），
 *    连一次槽都不问；kojo2 不声明旧桥，槽腿是它唯一那一枚。**这不叫收敛**：让位条件不成立
 *    （见第二条），所以按「注册面两枚 / 应答面一枚」留账。
 * 2. **槽腿只带 kojo2 那把尺子**：`renameProvider` 的 `resolveRenameLocation` 唯一调用
 *    `kojo2PrepareRename`（2.0 语法）。同一处 ERB 光标（`@M_KOJO_A(1)` / `CALL M_KOJO_A` /
 *    `$L1`）在这把尺子下**全数拒绝**，理由还是 2.0 的说法（「旧写法行（§12.1）不是 2.0 符号」
 *    「不是本文件声明的符号」）。ERB 的求值尺子住在插件 `@kojo/plugin-erb-parser`，由槽的
 *    `renameTarget` 成员应答，今天经**宿主腿**问。⇒ ERB 一旦点名 `rename`，F2 输入框的初值与
 *    「能不能改」这道门就换成 2.0 的尺子——不是少一枚 provider 的问题，是答错。
 *    真要收敛，前置条件是「槽腿的 prepare 尺子按 descriptor 分派」，不是把 `excludeNamed` 加上。
 * 3. **闭文件回写通道只在宿主腿**：ERB 改名的落点遍布全项目，未打开文件走
 *    `ErbRenameHandlers.applyToClosedFile`（`createApplyToClosedFile` → `rewriteClosedFile` →
 *    内核 io，保编码保换行 + 原子写 + 备份 + 写允许域）。槽腿那一格只会造 `WorkspaceEdit`
 *    的 `resource`（`uriForPath`），**一次盘都不写**（本文件第二条用例把 `io.writeText` 钉成
 *    spy）。⇒ 让 ERB 的宿主腿让位＝未打开文件从此不落盘（比静默没有更糟：盘上改一半）。
 *
 * kojo1 侧同一形状、另一条理由：它是待删除物，descriptor 不点名任何槽腿，宿主腿
 * （`installKojoRename`）是唯一应答者，槽腿在它上面同样恒弃权。
 *
 * 供方判据本体不在此重复：ERB 走 `erb-rename.test.ts` / `erb-label-rename.test.ts` /
 * `erb-rename-candidate-scope.test.ts`，kojo2 走 `kojo2-rename.test.ts`（含「共享收口挂到
 * ERB / kojo1 时弃权」那枚），kojo1 走 `kojo-rename.test.ts` / `kojo1-rename-model.test.ts`。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  EditorLanguageServiceContribution,
  EditorRenameResult,
  EditorRenameTargetResult,
} from '@kojo/plugin-api';
import { kojo2PrepareRename } from '@kojo/kojo-lang/rename';
import type * as Monaco from '../src/monaco/entry';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { installSlotServiceLegs, type SlotServiceHost } from '../src/monaco/slot-service-providers';
import { installErbRename, type ErbRenameHandlers } from '../src/monaco/erb-rename';
import { installKojoRename } from '../src/monaco/kojo-rename';
import { setGlobalKernel } from '../src/ui/editor-pane-registry';

const HERE = import.meta.dirname;
/** 槽腿工厂源码（「尺子只有一把」「没有落盘通道」两条取证读它） */
const SLOT_SOURCE = readFileSync(
  path.resolve(HERE, '..', 'src', 'monaco', 'slot-service-providers.ts'),
  'utf8',
);

/** 槽腿 rename 今天铺到的三枚 id（descriptor 序；新增/摘除一门语言会在这里红） */
const SLOT_RENAME_IDS = [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID] as const;

/* ============================== 桩 ============================== */

interface Registration {
  readonly selector: string;
  readonly provider: Monaco.languages.RenameProvider;
}

function fakeMonaco(): { readonly monaco: typeof Monaco; readonly registrations: Registration[] } {
  const registrations: Registration[] = [];
  const monaco = {
    languages: {
      registerRenameProvider: (selector: unknown, provider: unknown) => {
        registrations.push({ selector: String(selector), provider: provider as Monaco.languages.RenameProvider });
        return { dispose: () => undefined };
      },
    },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', path: p, toString: () => `file:///${p}` }) },
  } as unknown as typeof Monaco;
  return { monaco, registrations };
}

function fakeModel(filePath: string, languageId: string, text: string): Monaco.editor.ITextModel {
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

const AT = (line: number, column: number): Monaco.Position =>
  ({ lineNumber: line, column }) as Monaco.Position;

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

const ERB_PATH = 'C:/p/ERB/a.ERB';
const ERB_TEXT = '@M_KOJO_A(1)\nCALL M_KOJO_A\nJUMP 1, $L1\n$L1\n';
const KOJO2_PATH = 'D:/p/M.kojo';
const KOJO2_TEXT = '# 设 心情 整数 = 0\n';

/** 装一枚内核：记下每一问的 kind，并按 `answers` 应答 `rename` */
function installKernel(options: { readonly rename?: EditorRenameResult } = {}): {
  readonly askedKinds: string[];
  readonly writeText: ReturnType<typeof vi.fn>;
} {
  const askedKinds: string[] = [];
  const writeText = vi.fn();
  const contributions = [
    {
      id: 'rename-dualleg-stub',
      provide: (request: { kind: string }): unknown => {
        askedKinds.push(request.kind);
        if (request.kind !== 'rename') return undefined;
        return options.rename ?? { kind: 'rename', edits: [{ line: 1, startColumn: 5, endColumn: 7, newText: '情绪' }] };
      },
    } as unknown as EditorLanguageServiceContribution,
  ];
  setGlobalKernel({
    slots: { query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []) },
    project: { current: () => ({ adapterId: 'dualleg' }) },
    io: { isWritable: () => true, readText: () => '', writeText },
  } as never);
  return { askedKinds, writeText };
}

/** 宿主 ERB 腿的最小 handlers（本文件只数注册面，不驱动它的落盘分支） */
function erbHandlers(): ErbRenameHandlers {
  return {
    canAnswer: () => true,
    resolveTarget: (): EditorRenameTargetResult | undefined => undefined,
    resolveRename: () => undefined,
    isWritable: () => true,
    openModelFor: () => undefined,
    applyToClosedFile: async () => ({ applied: 0, stale: 0 }),
  };
}

/* ============================== ① 挂载面 / 应答面 ============================== */

describe('LAU-DUALLEG · rename 挂载面：一枚 model 上两枚、应答面一枚', () => {
  it('槽腿铺到 kojo-erb / kojo-legacy / kojo2 三枚 id（rename 腿在表里，不是 definition 那两格）', () => {
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename']);
    expect(fake.registrations.map((entry) => entry.selector)).toEqual([...SLOT_RENAME_IDS]);
    // 同一枚 provider 对象挂三门（非 perLanguage 腿）⇒ "两枚" 的计数单位是 id，不是工厂调用数
    expect(new Set(fake.registrations.map((entry) => entry.provider)).size).toBe(1);
  });

  it('宿主腿各再挂一枚：ERB 与 kojo1 各 2 枚同种 provider，kojo2 恰 1 枚', () => {
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename']);
    const erb = installErbRename(fake.monaco, erbHandlers());
    const kojo1 = installKojoRename(fake.monaco, { canAnswer: () => true, resolve: () => ({ edits: [] }) } as never);
    const countOf = (id: string): number =>
      fake.registrations.filter((entry) => entry.selector === id).length;
    expect(countOf(ERB_LANGUAGE_ID), 'ERB 上的 rename provider 枚数变了：双挂的账要重算').toBe(2);
    expect(countOf(KOJO_LANGUAGE_ID), 'kojo1 上的 rename provider 枚数变了').toBe(2);
    expect(countOf(KOJO2_LANGUAGE_ID), 'kojo2 只该有槽腿那一枚（原生 rename provider 已删）').toBe(1);
    erb.dispose();
    kojo1.dispose();
  });

  it('槽腿在 ERB / kojo1 上 prepare 与 edits 一律 undefined，且一次槽都不问（双挂不炸的唯一原因）', () => {
    const kernel = installKernel();
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename']);
    const slot = fake.registrations[0]!.provider;
    for (const [id, filePath, text] of [
      [ERB_LANGUAGE_ID, ERB_PATH, ERB_TEXT],
      [KOJO_LANGUAGE_ID, 'C:/p/a.kojo1', 'A = 1\n'],
    ] as const) {
      const model = fakeModel(filePath, id, text);
      expect(slot.resolveRenameLocation!(model, AT(2, 8), TOKEN), `${id} 上槽腿答了 prepare：点名表漏了`).toBeUndefined();
      expect(slot.provideRenameEdits!(model, AT(2, 8), 'M_KOJO_B', TOKEN), `${id} 上槽腿答了 edits`).toBeUndefined();
    }
    expect(kernel.askedKinds, '槽腿对未点名的语言仍去问槽 = 白问一遍并可能顶掉宿主腿').toEqual([]);
  });

  it('槽腿在 kojo2 上真是应答者：prepare 给 2.0 名字段区间，edits 问槽 kind=rename', () => {
    const kernel = installKernel();
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename']);
    const slot = fake.registrations[0]!.provider;
    const model = fakeModel(KOJO2_PATH, KOJO2_LANGUAGE_ID, KOJO2_TEXT);
    const prepared = slot.resolveRenameLocation!(model, AT(1, 6), TOKEN) as Monaco.languages.RenameLocation &
      Monaco.languages.Rejection;
    expect(prepared.rejectReason).toBeUndefined();
    expect(prepared.text).toBe('心情');
    expect(prepared.range).toEqual({ startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 7 });
    const edits = slot.provideRenameEdits!(model, AT(1, 6), '情绪', TOKEN) as Monaco.languages.WorkspaceEdit &
      Monaco.languages.Rejection;
    expect(edits.rejectReason).toBeUndefined();
    expect(edits.edits).toHaveLength(1);
    expect(kernel.askedKinds).toEqual(['rename']);
  });
});

/* ============================== ② 两把 prepare 尺子 ============================== */

describe('LAU-DUALLEG · rename 两把尺子：槽腿只有 kojo2 那把 ⇒ ERB 不许点名', () => {
  it('kojo2PrepareRename 对 ERB 三处位点全数拒绝，理由逐字是 2.0 的说法', () => {
    const cases: readonly (readonly [string, number, number, string])[] = [
      ['定义名 @M_KOJO_A', 1, 4, '旧写法行（§12.1）不是 2.0 符号'],
      ['调用名 CALL M_KOJO_A', 2, 8, '不是本文件声明的符号'],
      ['$ 标签 $L1', 4, 2, '不是本文件声明的符号'],
    ];
    for (const [label, line, column, reason] of cases) {
      const prepared = kojo2PrepareRename(ERB_TEXT, { line, column });
      expect(prepared.symbol, `${label}：2.0 尺子竟认下了 ERB 位点，本组的留账理由要重写`).toBeNull();
      expect(prepared.range).toBeNull();
      expect(prepared.blockers.join('\n'), label).toContain(reason);
    }
  });

  it('槽腿的 prepare 只调 kojo2PrepareRename：rename 腿体内没有第二把尺子（renameTarget）', () => {
    const legBody = SLOT_SOURCE.slice(
      SLOT_SOURCE.indexOf('function renameProvider('),
      SLOT_SOURCE.indexOf('/* ============================== 表 + 安装 =============================='),
    );
    expect(legBody.length, '没截到 rename 腿的函数体：取证窗口失效').toBeGreaterThan(200);
    expect(legBody).toContain('kojo2PrepareRename');
    expect(legBody, '槽腿里出现第二把尺子：本组的"两把尺子"论断要重判').not.toContain('renameTarget');
  });

  it('ERB 的求值尺子在宿主腿：prepare 走 handlers.resolveTarget（renameTarget），注册仍直挂 ERB id', () => {
    const erbSource = readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'erb-rename.ts'), 'utf8');
    expect(erbSource).toContain('registerRenameProvider(ERB_LANGUAGE_ID');
    expect(erbSource).toContain('kind: \'renameTarget\'');
    expect(erbSource).not.toMatch(/excludeNamed/);
    expect(erbSource, 'ERB 宿主腿里出现了 kojo2 的尺子：两把尺子必须各守各门').not.toContain('kojo2PrepareRename');
  });
});

/* ============================== ③ 闭文件回写通道 ============================== */

describe('LAU-DUALLEG · rename 的闭文件回写通道只在宿主腿', () => {
  it('槽腿交回的落点只有 WorkspaceEdit（跨文件 resource 走注入的 uriForPath），全程不碰内核 io', () => {
    const kernel = installKernel({
      rename: {
        kind: 'rename',
        edits: [
          { line: 1, startColumn: 5, endColumn: 7, newText: '情绪' },
          { line: 3, startColumn: 6, endColumn: 8, newText: '情绪', resourcePath: 'D:/p/other.kojo' },
        ],
      } satisfies EditorRenameResult,
    });
    const host: SlotServiceHost = { uriForPath: (target) => ({ fsPath: target, scheme: 'file', path: target, toString: () => `file:///${target}` }) as Monaco.Uri };
    const fake = fakeMonaco();
    installSlotServiceLegs(fake.monaco, ['rename'], host);
    const out = fake.registrations[0]!.provider.provideRenameEdits!(
      fakeModel(KOJO2_PATH, KOJO2_LANGUAGE_ID, KOJO2_TEXT),
      AT(1, 6),
      '情绪',
      TOKEN,
    ) as Monaco.languages.WorkspaceEdit;
    expect((out.edits ?? []).map((edit) => String((edit as { resource: { toString(): string } }).resource))).toEqual([
      'file:///D:/p/M.kojo',
      'file:///D:/p/other.kojo',
    ]);
    expect(kernel.writeText, '槽腿开始写盘 = 第二套落盘通道，写边界纪律会分叉').not.toHaveBeenCalled();
  });

  it('源码取证：落盘通道只在宿主侧（applyToClosedFile / rewriteClosedFile 不在槽腿工厂里）', () => {
    expect(SLOT_SOURCE).not.toMatch(/applyToClosedFile|rewriteClosedFile|io\.writeText/);
    const erbSource = readFileSync(path.resolve(HERE, '..', 'src', 'monaco', 'erb-rename.ts'), 'utf8');
    expect(erbSource).toContain('export function createApplyToClosedFile');
    expect(erbSource).toContain('applyToClosedFile(');
    const assembly = readFileSync(path.resolve(HERE, '..', 'src', 'ui', 'editor-global-providers.ts'), 'utf8');
    expect(assembly).toContain('applyToClosedFile: createApplyToClosedFile(renameClosedFileIo)');
  });
});
