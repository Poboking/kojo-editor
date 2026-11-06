/**
 * ERB 未定义名诊断 —— 真实语料精度闸门（`KOJO_SMOKE_PROJECT` 守门，没有语料盘自动跳过）。
 *
 * 与 `structure.corpus.test.ts` 同一性质：**把"在作者实际写出来的东西上到底误报多少"
 * 固化成回归**。单测只证明"想到的形态判得对"，证明不了"没想到的形态不误报"。
 *
 * 名字尺（ERBDIAG-A / D01）：本闸门存在的理由就是钉死"未定义名腿切名字的尺子 = 引擎那把"。
 * 引擎真源 `Emuera/Runtime/Script/Parser/LexicalAnalyzer.cs` 的 `_searchValues` ⇒
 * **名字 = 不含这些字符的极大段**。改前实测（eraTW 4.981，4,258 份 / 4,376,079 行）
 * 未定义名腿报 **1,190** 条，其中 1,141 条（95.9%）的诊断记号紧邻 `·`(U+00B7) 一类
 * **非**引擎分隔符——即"一把正则尺劈开一个名字"造的假红。换尺后同一棵树同一测法 = **49** 条。
 *
 * 闸门的目标值：**剩余 ≤ 60 条**，且剩余命中**逐条归类**（真 latent bug / 引擎内建词表缺项），
 * `未解释 = 0`。任何一条新类别的假红都必须先改判据、不许放宽这里。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ERB_ENGINE_RESERVED_IDENTIFIERS,
  ERB_ENGINE_STRING_IDENTIFIERS,
  functionLookupOf,
  isErbDialectPath,
} from '@kojo/plugin-api';
import type { ErbFile, ErbIndex } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { projectDeclaredNames } from '../src/dim-index';
import { parseErbText } from '../src/scanner';
import { collectUndefinedNameDiagnostics } from '../src/undefined-name';

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

/** 剩余命中的**台账**：记号（大写归一）→ 定性。台账外的记号 = 未解释 = 闸门红。 */
type ResidualKind = 'latent-bug' | 'engine-builtin-vocab-gap';
/**
 * 逐条核实（不是抄来的定性）：
 * - `COUNT`（14）= 引擎系统变量「繰り返しカウンター」：`VariableDescriptor.cs:109` /
 *   `VariableCode.cs:41` / `VariableData.cs:183` 三处都登记在册，
 *   但 `@kojo/plugin-api` 的 `ERB_ENGINE_RESERVED_IDENTIFIERS` 里没有这一枚
 *   ⇒ **不是名字尺的问题，是词表缺项**（本批不碰别人的词表）。
 * - `Y`（33）= 同上：`VariableDescriptor.cs:148` / `VariableData.cs:222`（GRAPH 坐标族），
 *   全语料 0 处 `#DIM Y` ⇒ 只能来自引擎内建。
 * - `__INT_MAX__`（1）= 引擎伪变量（Int64 最大値，`VariableCode.cs:280` /
 *   `VariableData.cs:347`），词表同样缺这一枚。
 * - `B`（1）= **真 latent bug**：`ERB/ステータス計算関連/SOURCE/SOURCE_1.ERB:553`
 *   `ELSEIF B < 100000000`——上一个分支写的是 `LOCAL:2`，这里读一枚全语料查无声明的 `B`
 *   （引擎侧 `IdentifierDictionary.cs:643` 到运行期才 `IdentifierNotFoundCodeEE`，
 *   加载期不拦 ⇒ 作者看不见，正是这条规则该报的形状）。
 */
const RESIDUAL_LEDGER: Readonly<Record<string, ResidualKind>> = {
  COUNT: 'engine-builtin-vocab-gap',
  Y: 'engine-builtin-vocab-gap',
  __INT_MAX__: 'engine-builtin-vocab-gap',
  B: 'latent-bug',
};

function erbFilesUnder(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) erbFilesUnder(p, out);
    else if (isErbDialectPath(e.name)) out.push(p);
  }
}

describe.skipIf(!SMOKE)('ERB 未定义名 · 真实语料精度闸门（名字尺＝引擎那把）', () => {
  it('全量语料命中 ≤60 且剩余逐条归类（附反证）', async () => {
    const root = join(SMOKE!, 'ERB');
    statSync(root); // 语料在但结构不符预期 ⇒ 显式失败，不静默跳过
    const files: string[] = [];
    erbFilesUnder(root, files);
    expect(files.length, '语料 ERB 文件数').toBeGreaterThan(4000);

    const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));

    // ---- 名录趟：与生产同一条来路（`parseErbText` → `ErbFile.dims` → `projectDeclaredNames`）----
    const parsedFiles: ErbFile[] = [];
    let lines = 0;
    for (const f of files) {
      const tf = await io.readText(f);
      lines += tf.text.split('\n').length;
      parsedFiles.push(parseErbText(tf.text, f));
    }
    const index = { files: new Map(parsedFiles.map((f) => [f.path, f])), byName: functionLookupOf([]) } as ErbIndex;
    const declared = projectDeclaredNames(index);

    // ---- 诊断趟：逐文件重读，注入与生产同款的名录 + 引擎两张词表 ----
    const hits: string[] = [];
    const tokens = new Map<string, number>();
    for (const f of files) {
      const tf = await io.readText(f);
      const diags = collectUndefinedNameDiagnostics({
        text: tf.text,
        path: f,
        dimNames: declared.dims,
        stringNames: declared.strings,
        builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
        engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
        maxSuggestions: 0,
      });
      for (const d of diags) {
        hits.push(`${f.replace(SMOKE!, '')}:${d.line} ${d.name}`);
        const key = d.name.toUpperCase();
        tokens.set(key, (tokens.get(key) ?? 0) + 1);
      }
    }

    console.log(
      `[undef-name] 语料 ${files.length} 文件 / ${lines} 行；名录 ${declared.dims.length} 条` +
        `（字符串型 ${declared.strings.length}）；命中 ${hits.length} 条 / ${tokens.size} 种记号`,
    );
    for (const h of hits) console.log(`  ${h}`);

    // ---- 目标值（改前=1,190，必须红在这一格）----
    expect(hits.length, `命中总数（台账见 RESIDUAL_LEDGER）：\n${hits.join('\n')}`).toBeLessThanOrEqual(60);

    // ---- 剩余逐条归类：台账外的记号 = 未解释 ----
    const unexplained: string[] = [];
    for (const [key, count] of tokens) {
      if (RESIDUAL_LEDGER[key] === undefined) unexplained.push(`${key}×${count}`);
    }
    expect(unexplained.sort(), `未解释剩余（应为空）：\n${unexplained.join('\n')}`).toEqual([]);

    // ---- 反证：判据确实在工作，不是"整条腿静默不报"----
    // ① 真语料的"名字内含 `·`"使用点：原样不报，改一个字符必须报（同一个名字段）
    const usagePath = join(root, 'DLC', '音乐补丁', '音乐播放.ERB');
    statSync(usagePath);
    const usage = await io.readText(usagePath);
    const line = usage.text.split('\n').find((l) => l.includes('P23温泉·更衣间'));
    expect(line, '语料里找不到 `P23温泉·更衣间` 的使用行（先看语料，别改判据）').toBeDefined();
    const original = collectUndefinedNameDiagnostics({
      text: `SIF GROUPMATCH(ARG, P23温泉·更衣间)\n`,
      path: 'X.ERB',
      dimNames: declared.dims,
      stringNames: declared.strings,
      builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
      engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
    });
    expect(original, `名字含 · 的一个整段必须整段命中声明：${JSON.stringify(original)}`).toEqual([]);
    const typo = collectUndefinedNameDiagnostics({
      text: 'SIF GROUPMATCH(ARG, P23温泉·更衣问)\n',
      path: 'X.ERB',
      dimNames: declared.dims,
      stringNames: declared.strings,
      builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
      engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
    });
    expect(typo.map((d) => d.name), '改一个字⇒ 整段照报（不许退化成"半段"）').toEqual(['P23温泉·更衣问']);
    // ② 全语料名录之外：一条普通未知名照报（判据没被台账/词表吞掉）
    expect(
      collectUndefinedNameDiagnostics({
        text: 'IF ERBDIAG_A_NEVER_DECLARED > 0',
        path: 'X.ERB',
        dimNames: declared.dims,
        builtinNames: ERB_ENGINE_RESERVED_IDENTIFIERS,
        engineStringNames: ERB_ENGINE_STRING_IDENTIFIERS,
      }).map((d) => d.name),
    ).toEqual(['ERBDIAG_A_NEVER_DECLARED']);
  }, 600000);
});
