import { functionLookupOf } from '@kojo/plugin-api';
import type { ErbDim, ErbFile, ErbFunctionRef, ErbIndex, GameProject, InlineCompletionRequest } from '@kojo/plugin-api';

/**
 * 测试夹具（**非** `.test.ts`：vitest 的 include 只收 `*.test.ts`，这份不会被当成用例跑）。
 *
 * 形状刻意"最小但合法"：本包的判据只读 `byName` 的键、`files[*].dims[*]` 的
 * `name`/`directive`、以及请求里的那几个字段，其余索引字段一概不碰
 * （碰了就得在这里替契约补假数据，夹具会长成第二份真相）。
 */

/** 一份开着的工程（本包只看 `project === null` 与否，字段不参与判据） */
export const OPEN_PROJECT = {
  rootDir: 'D:/game',
  kojoPaths: ['D:/game/ERB'],
  adapterId: 'fixture',
} as unknown as GameProject;

/** 归一化（解析器口径：大写） */
export function norm(name: string): string {
  return name.toUpperCase();
}

/** 造一条 `@` 定义（byName 的 value 只需要 `name` 参与判据） */
function ref(name: string, filePath = 'D:/game/ERB/A.erb', startLine = 1): ErbFunctionRef {
  return { name, normalizedName: norm(name), filePath, startLine, endLine: startLine + 5 };
}

/** 造一份索引：`functions` = 函数名原形集，`dims` = 声明名（名字 → 指令） */
export function fakeIndex(opts: {
  readonly functions?: readonly string[];
  readonly dims?: readonly (readonly [name: string, directive?: string])[];
  readonly byNameExtras?: ReadonlyMap<string, readonly ErbFunctionRef[]>;
}): ErbIndex {
  const byName = new Map<string, ErbFunctionRef[]>();
  for (const name of opts.functions ?? []) {
    byName.set(norm(name), [ref(name)]);
  }
  for (const [key, refs] of opts.byNameExtras ?? new Map()) byName.set(key, [...refs]);

  const dims: ErbDim[] = (opts.dims ?? []).map(([name, directive]) => ({
    name,
    directive: (directive ?? 'DIM').toUpperCase(),
    line: 1,
  }));
  const file: ErbFile = {
    path: 'D:/game/ERB/A.erb',
    functions: [],
    dims,
    hasFunctionDirective: false,
    lineCount: 10,
  };
  const files = new Map<string, ErbFile>([['D:/game/ERB/A.erb', file]]);
  return { files, byName: functionLookupOf(byName), fingerprint: 'fixture-fp' };
}

/** 空索引（一个名字都没有：用来验"名录在场但没命中"） */
export function emptyIndex(): ErbIndex {
  return { files: new Map<string, ErbFile>(), byName: functionLookupOf([]), fingerprint: 'empty' };
}

/**
 * 造一次请求：调用形态与 `erbNameSlotAt(prefix, suffix)` 逐字同构 ——
 * **光标就写在 `prefix` 的末尾**，`suffix` 是光标右侧那一截。
 *
 * 这样夹具就没有"第三处光标"可写错（早期版本按 `text + cursor` 切，与判定层的入参形态
 * 不同轴，测试写起来一半的调用点会静默把光标停在行首）。
 * `lineText` 由两段拼出，但**本包从不读它**（`provider.test.ts` 有一条专门把 lineText 换成
 * 歪值仍要成立的闸）。
 */
export function requestAt(
  prefix: string,
  suffix = '',
  over: Partial<InlineCompletionRequest> = {},
): InlineCompletionRequest {
  const text = prefix + suffix;
  return {
    path: 'D:/game/ERB/A.erb',
    languageId: 'kojo-erb',
    version: 7,
    line: 1,
    column: prefix.length + 1,
    lineText: text,
    prefix,
    suffix,
    contextBefore: prefix,
    contextAfter: suffix,
    project: OPEN_PROJECT,
    triggerKind: 'auto',
    timeoutMs: 120,
    ...over,
  };
}
