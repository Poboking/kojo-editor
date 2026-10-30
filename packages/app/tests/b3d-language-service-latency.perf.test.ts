/**
 * B3d · 语言服务**热路径**的同步延迟读数（OPT-3）：插件供方路径 vs 直调纯函数的差量。
 *
 * 本批把签名 / 格式化的判据从宿主搬进了 `@kojo/kojo-lang`，宿主 provider 的每次击键 / 快捷键
 * 现在多走两跳：`provider → legs（collect*）→ 插件贡献 → 包内纯函数`。这条链路是**同步**的
 * （Monaco 的 provider 协议按同步结果收，异步会翻成"提示慢一拍"），所以只看同步差量，
 * 不看吞吐、不测 IO。
 *
 * 口径（与任务书 OPT-3 一致）：
 * - 两侧都用**同一份**源码与同一个桩 model；A = 直调包内纯函数，B = 走安装器装出的 provider
 *   （桩内核里一枚贡献，贡献体就是 A 的那一句——模拟插件供方）；
 * - N = 300，先各暖机 20 次（JIT 分层不计入），报 median / p95；
 * - 判据：|median(B) − median(A)| ≤ 0.5 ms **或** median(B) ≤ 1.1 × median(A)。
 *   **不钉绝对耗时**：这台机器 / CI 的绝对值没有意义，钉的是"多出来的间接可忽略"。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution } from '@kojo/plugin-api';
import { formatKojo2Source } from '@kojo/kojo-lang/format';
import { kojo2SignatureAt } from '@kojo/kojo-lang/signature';
import { provideFormatting, provideSignatureHelp } from '@kojo/plugin-kojo-lang';
import type * as Monaco from '../src/monaco/entry';
import { KOJO2_LANGUAGE_ID } from '../src/monaco/kojo2-language';
import { setGlobalKernel, requireKernel } from '../src/ui/editor-pane-registry';
// SDK-B5b 车 2（2026-10-31）：两枚安装器并入语言无关的槽腿工厂（按 kind 只装那一条腿）。
import { installSlotServiceLegs } from '../src/monaco/slot-service-providers';

/* ============================== 夹具 ============================== */

/** 一份"有得排、有签名可问"的 2.0 文档（约 20 行；量级对齐真实口上文件的常态） */
const SOURCE = [
  '# 幕 神社清晨',
  '# 视角 灵梦',
  '',
  '# 设 容量 整数 = 5',
  '# 设 队伍 整数[3]',
  '',
  '# 对照表 心情 依据 好感',
  '  0..99 -> 疏远',
  '  100..499 -> 平常',
  '  否 -> 未知',
  '',
  '@函 增加羁绊(目标, 数值=10)',
  '    @返 数值',
  '',
  '# 池 早安问候',
  '  ? 好感 < 100',
  '      「……早。」',
  '  ? 否',
  '      「早上好。」',
  '',
  '! 增加羁绊(目标, 12)',
  '',
].join('\n');

/** 光标位点：最后一行的第二个实参（1 基） */
const CALL_LINE = 21;
const CALL_COLUMN = '! 增加羁绊(目标, 1'.length + 1;

const SIGNATURE_POINT = { line: CALL_LINE, column: CALL_COLUMN };

interface FakeModel {
  getValue(): string;
  getLineMaxColumn(line: number): number;
  getLanguageId(): string;
  getVersionId(): number;
  uri: { scheme: string; path: string; fsPath: string };
}

/** 每次发一枚**新** model：provider 侧若有按 model 的缓存，别让第二跳白拿 */
function fakeModel(): Monaco.editor.ITextModel {
  const rows = SOURCE.split('\n');
  const model: FakeModel = {
    getValue: () => SOURCE,
    getLineMaxColumn: (line) => (rows[line - 1] ?? '').length + 1,
    getLanguageId: () => KOJO2_LANGUAGE_ID,
    getVersionId: () => 1,
    uri: { scheme: 'file', path: '/proj/chara.kojo2', fsPath: '/proj/chara.kojo2' },
  };
  return model as unknown as Monaco.editor.ITextModel;
}

type KernelLike = Parameters<typeof setGlobalKernel>[0];

function installKernel(contributions: readonly EditorLanguageServiceContribution[]): void {
  setGlobalKernel({
    slots: {
      query: (slot: string) => (slot === 'ui.editor.languageService' ? contributions : []),
    },
    project: { current: () => null },
  } as unknown as KernelLike);
  // 自检：本文件与 provider 必须看到**同一个**内核登记簿（否则下面量的是空转）
  expect(requireKernel().slots.query('ui.editor.languageService')).toBe(contributions);
}

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as Monaco.CancellationToken;

/* ============================== 计时工具 ============================== */

const N = 300;
const WARMUP = 20;

interface Reading {
  readonly median: number;
  readonly p95: number;
}

function measure(run: () => number): Reading {
  for (let i = 0; i < WARMUP; i += 1) run();
  const samples: number[] = [];
  for (let i = 0; i < N; i += 1) {
    const startedAt = performance.now();
    run();
    samples.push(performance.now() - startedAt);
  }
  samples.sort((a, b) => a - b);
  const at = (q: number): number => samples[Math.min(N - 1, Math.floor(q * N))]!;
  return { median: at(0.5), p95: at(0.95) };
}

function report(label: string, direct: Reading, viaProvider: Reading): void {
  console.log(
    `[b3d-latency] ${label}：直调 median ${direct.median.toFixed(4)} ms / p95 ${direct.p95.toFixed(4)} ms；` +
      `经 provider median ${viaProvider.median.toFixed(4)} ms / p95 ${viaProvider.p95.toFixed(4)} ms`,
  );
}

function expectNegligibleOverhead(direct: Reading, viaProvider: Reading): void {
  const delta = viaProvider.median - direct.median;
  const ratio = direct.median === 0 ? Number.POSITIVE_INFINITY : viaProvider.median / direct.median;
  // 两条判据任一成立即过：绝对差 ≤ 0.5 ms（大数下比例会被噪声放大），或比例 ≤ 1.1×
  expect(
    Math.abs(delta) <= 0.5 || ratio <= 1.1,
    `插件供方路径的同步开销超预算：Δ ${delta.toFixed(4)} ms / ${ratio.toFixed(2)}×`,
  ).toBe(true);
}

/* ============================== 签名帮助 ============================== */

describe('签名帮助：provider 两跳 vs 直调 `kojo2SignatureAt`', () => {
  it('N=300 的 median / p95 差量可忽略（|Δ| ≤ 0.5 ms 或 ≤ 1.1×）', () => {
    installKernel([
      // 真实的插件供方（provider → legs → 插件 → 包），不是手搓的同形桩
      { id: 'kojo2-signatureHelp', provide: (request) => provideSignatureHelp(request) },
    ]);

    let provider: Monaco.languages.SignatureHelpProvider | undefined;
    const fakeMonacoStub = {
      languages: {
        registerSignatureHelpProvider: (_selector: unknown, registered: unknown) => {
          provider = registered as Monaco.languages.SignatureHelpProvider;
          return { dispose: () => undefined };
        },
      },
    } as unknown as typeof Monaco;
    installSlotServiceLegs(fakeMonacoStub, ['signatureHelp']);
    if (provider === undefined) throw new Error('签名 provider 没挂上');

    // 预检：两条路径必须都真的**答出同一条签名**（不然计的是空转）
    const directHelp = kojo2SignatureAt(SOURCE, SIGNATURE_POINT, { adapter: null })!;
    expect(directHelp.signatures[0]!.label).toBe('增加羁绊(目标, 数值 = 10)');
    const viaHelp = provider.provideSignatureHelp(
      fakeModel(),
      { lineNumber: CALL_LINE, column: CALL_COLUMN } as Monaco.Position,
      TOKEN,
      {} as Monaco.languages.SignatureHelpContext,
    ) as Monaco.languages.SignatureHelpResult;
    expect(viaHelp.value.signatures[0]!.label).toBe(directHelp.signatures[0]!.label);

    const direct = measure(
      () => kojo2SignatureAt(SOURCE, SIGNATURE_POINT, { adapter: null })!.signatures.length,
    );
    const viaProvider = measure(
      () =>
        (
          provider!.provideSignatureHelp(
            fakeModel(),
            { lineNumber: CALL_LINE, column: CALL_COLUMN } as Monaco.Position,
            TOKEN,
            {} as Monaco.languages.SignatureHelpContext,
          ) as Monaco.languages.SignatureHelpResult
        ).value.signatures.length,
    );
    report('签名帮助', direct, viaProvider);
    expectNegligibleOverhead(direct, viaProvider);
  });
});

/* ============================== 格式化 ============================== */

describe('格式化：provider 两跳 vs 直调 `formatKojo2Source`', () => {
  it('N=300 的 median / p95 差量可忽略（|Δ| ≤ 0.5 ms 或 ≤ 1.1×）', () => {
    installKernel([{ id: 'kojo2-formatting', provide: (request) => provideFormatting(request) }]);
    let provider: Monaco.languages.DocumentFormattingEditProvider | undefined;
    const fakeMonacoStub = {
      languages: {
        registerDocumentFormattingEditProvider: (_selector: unknown, registered: unknown) => {
          provider = registered as Monaco.languages.DocumentFormattingEditProvider;
          return { dispose: () => undefined };
        },
        // 工厂的 formatting 腿同时挂整篇与区间两枚 provider（B5b 车 2）；桩要能应答两者。
        registerDocumentRangeFormattingEditProvider: () => ({ dispose: () => undefined }),
      },
    } as unknown as typeof Monaco;
    installSlotServiceLegs(fakeMonacoStub, ['formatting']);
    if (provider === undefined) throw new Error('格式化 provider 没挂上');

    const directResult = formatKojo2Source(SOURCE);
    expect(directResult.changed).toBe(true);
    const preflight = provider.provideDocumentFormattingEdits(
      fakeModel(),
      {} as Monaco.languages.FormattingOptions,
      TOKEN,
    ) as Monaco.languages.TextEdit[];
    expect(preflight).toHaveLength(directResult.edits!.length);

    const direct = measure(() => formatKojo2Source(SOURCE).edits!.length);
    const viaProvider = measure(
      () =>
        (
          provider!.provideDocumentFormattingEdits(
            fakeModel(),
            {} as Monaco.languages.FormattingOptions,
            TOKEN,
          ) as Monaco.languages.TextEdit[]
        ).length,
    );
    report('格式化', direct, viaProvider);
    expectNegligibleOverhead(direct, viaProvider);
  });
});
