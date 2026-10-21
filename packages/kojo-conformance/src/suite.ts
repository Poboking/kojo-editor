/**
 * CLI 内建用例（`list-cases` 的数据源，`check --suite` 的执行体）。
 *
 * 口径：
 * - 只钉 `FIXTURE_ADAPTER` / `FIXTURE_BACKEND` 的**抽象行为**，不引入任何具体游戏事实；
 * - 三个面各一条（golden / readings / encoding），是 conformance kit 自身"能独立跑起来"的
 *   最小证据，**不是** adapter 作者的验收集——真实 adapter 的用例由调用方注入；
 * - 期望产物是 fixture backend 的确定性字节（`MACHINE` / `TELL` / `/WAIT`），
 *   任何 adapter 都能照着这份形状替换自己的 backend，但 kit 不解释这些 token。
 */
import type { AdapterConformanceCase } from './kit.js';
import { encodeConformanceTextPreservingEol } from './encoding.js';

/** 一条内建用例 + 面向 `list-cases` 的一句话说明 */
export interface BuiltinConformanceCase {
  readonly case: AdapterConformanceCase;
  readonly description: string;
}

/** 最小叙事：`# 机` 事件头 + 一句旁白（fixture 背约的确定性产物见下） */
const NARRATION_SOURCE = '# 机 开场\n> 你好\n';

/** fixture backend 的确定性字节：`MACHINE` 头 / 文本行 / 尾 */
const NARRATION_GOLDEN = 'MACHINE 开场\nTELL: 你好 /WAIT\nMACHINE.END\n';

/** 同一段文本的 CRLF 形状（encoding 面：EOL 不得泄漏进产物） */
const NARRATION_CRLF_SOURCE = '# 机 开场\r\n> 你好\r\n';

/**
 * 内建用例（顺序即 `check --suite` 的执行序与 `list-cases` 的列出序）。
 *
 * `encoding` 用例的字节由文本按契约编码合成（`utf-8` + CRLF，无 BOM）；
 * kit 会把它 decode 回文本再编译，并对拍编码/EOL 保留、BOM/EOL 不变性。
 */
export const BUILTIN_CONFORMANCE_CASES: readonly BuiltinConformanceCase[] = Object.freeze([
  {
    case: Object.freeze({
      kind: 'golden',
      name: 'builtin/golden-narration',
      source: NARRATION_SOURCE,
      expectedErb: NARRATION_GOLDEN,
    }),
    description: '叙事 + `# 机` 事件头的最小 golden（产物逐字节）',
  },
  {
    case: Object.freeze({
      kind: 'readings',
      name: 'builtin/readings-narration',
      source: NARRATION_SOURCE,
      readings: Object.freeze({
        events: Object.freeze([
          Object.freeze({ source: 'machine' as const, event: '开场', args: Object.freeze([]) }),
        ]),
        waits: Object.freeze([Object.freeze({ kind: 'text' as const, wait: 'wait' as const })]),
        slots: Object.freeze([]),
        sourceMapLines: 3,
        artifactLines: 3,
      }),
    }),
    description: '事件 / 等待 / source map 行数读数（不靠产物 token 拼写）',
  },
  {
    case: Object.freeze({
      kind: 'encoding',
      name: 'builtin/encoding-crlf',
      bytes: encodeConformanceTextPreservingEol(NARRATION_CRLF_SOURCE, 'utf-8'),
      encoding: Object.freeze({
        sourceEncoding: 'utf-8' as const,
        sourceEol: 'crlf' as const,
        preserveBom: true,
        preserveEol: true,
      }),
    }),
    description: 'CRLF 源文件的编码/EOL 保留（EOL 不得改变产物行为）',
  },
]);

/** 供 `check --suite` / 测试使用的纯用例数组（去掉说明） */
export function builtinConformanceCases(): readonly AdapterConformanceCase[] {
  return BUILTIN_CONFORMANCE_CASES.map((entry) => entry.case);
}
