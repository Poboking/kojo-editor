/**
 * Kojo 2.0 文件级 Host 上下文（M2-P1）。
 *
 * 这里只做两件事：
 * 1. 复用既有 `charNoForProjectPath` 算法，从 `GameProject.charaIndex[].kojoDir` 最长前缀推角色号；
 * 2. 把角色号与 Host 明确提供的 familySegment 组合成 core 的 `FunctionNameContext`。
 *
 * 红线：缺席 ≠ 空串。familySegment 没有事实就保持缺失；标准版必须由 Host **显式**传 `''`。
 * 本模块不从文件名猜家族，也不从 Theater raw target 猜 `{i}`。
 */
import type { FunctionNameContext } from '@kojo/kojo-core';
import type { GameProject } from '@kojo/plugin-api';
import { isPathUnder, pathKey } from '@kojo/plugin-api';

export interface Kojo2FunctionNameContextFile {
  readonly path: string;
  readonly layerId?: string | null;
}

/** Host 文件级家族段解析器；返回 undefined = 没有事实（不是空串）。 */
export type Kojo2FamilySegmentResolver = (file: Kojo2FunctionNameContextFile) => string | undefined;

/**
 * 从 `GameProject.charaIndex` 推角色号：**最长目录前缀**命中者胜（与文件树分组的
 * `kojoOwners` 同一条"长前缀优先"口径，避免嵌套目录误归属）。
 *
 * 纯函数、零 IO；`charaIndex` 缺席 / 文件不在任何 `kojoDir` 下 ⇒ `undefined`（不猜）。
 * 路径归一走契约的 `pathKey`（Windows 分隔符 / 大小写差异下同一个文件必须判得上）。
 */
export function charNoForProjectPath(project: GameProject | null, filePath: string): string | undefined {
  if (project === null) return undefined;
  // 契约上 `charaIndex` 是必填，但 `kernel.project.current()` 交给这里的是**运行期对象**：
  // 工程正在装载时它可能还是半成品。少了索引就让"这条链路抛 TypeError"顶掉真正的诊断
  // 结论（`onFailure` 会把 `Cannot read properties of undefined` 原样抖给作者），
  // 而正确语义是"推不出角色号"——由 backend 的 fail-closed 如实报缺。
  const index: GameProject['charaIndex'] | undefined = project.charaIndex;
  if (index === undefined || index === null || typeof index.values !== 'function') return undefined;
  let bestLength = -1;
  let found: string | undefined;
  for (const chara of index.values()) {
    if (typeof chara.kojoDir !== 'string' || chara.kojoDir.length === 0) continue;
    // 归属判据（分隔符 / 大小写）走契约的 `isPathUnder`，不在这里手写 startsWith——
    // win32 归一化后的分隔符是 `\`，拿 `/` 拼前缀在 Windows 上会恒定判不上。
    if (!isPathUnder(chara.kojoDir, filePath)) continue;
    const length = pathKey(chara.kojoDir).length;
    if (length > bestLength) {
      bestLength = length;
      found = String(chara.no);
    }
  }
  return found;
}

/**
 * 生成文件级 `FunctionNameContext`。
 *
 * - charNo 由既有算法推；推不到就不写该键。
 * - familySegment 只认 Host 注入的解析器；即使 resolver 返回 `''` 也保留为显式空串。
 * - 本阶段不生成 index / com：前者依赖 Theater 目标参数（未闭合），后者归 P2 TargetRegistry。
 */
export function kojo2FunctionNameContextForFile(
  project: GameProject | null,
  file: Kojo2FunctionNameContextFile,
  familySegmentOf?: Kojo2FamilySegmentResolver,
): FunctionNameContext {
  const context: { charNo?: string; familySegment?: string } = {};
  const charNo = charNoForProjectPath(project, file.path);
  if (charNo !== undefined) context.charNo = charNo;
  if (familySegmentOf !== undefined) {
    const familySegment = familySegmentOf(file);
    if (familySegment !== undefined) context.familySegment = familySegment;
  }
  return context;
}