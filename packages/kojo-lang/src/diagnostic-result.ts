/**
 * **文档级诊断那一轮编译的成品**登记表（一次编译两处消费的跨层缝）。
 *
 * ## 它解决什么
 *
 * 2.0 的诊断那一轮 `compileKojoSource` 同时产出三样东西：诊断（波浪线 + 问题面板）、
 * 产物 `erb`、与产物同一次的 source map（预览面板 / 展开视图）。B3 收口之后**编译由插件
 * 发起**（判据住 `diagnostics.ts`、供方住 `@kojo/plugin-kojo-lang`），而预览 / 展开的
 * 消费方是宿主面板——两边不在同一边，中间就需要一块**只读交接面**。
 *
 * 三条路都比这一条差：
 * - 让预览自己再编译一次：两份结果；哪怕输入一字不差，source map 也是两个对象，"用 A 次的
 *   产物配 B 次的 map"错位跳行是静默的数据级缺陷（K2-EDITOR-MOUNT ① 的原始动机）；
 * - 让插件把产物塞进槽：`ui.editor.decorator` 的契约产出只有 `LineDecoration`，塞私货就是
 *   给这个槽开第二套形状；
 * - 宿主保留一份"兜底编译"：那就是第二份判据（本仓最贵的一类债）。
 *
 * 所以：**插件写、宿主读**，与 `adapter-source`（宿主写、插件读）正好一对。
 *
 * ## 口径
 *
 * - 键 = 归一后的路径（Windows 盘符路径大小写不敏感；分隔符统一 `/`）；
 * - **有界**：只留最近 {@link KOJO2_DIAGNOSTIC_RESULTS_LIMIT} 份——作者来回切标签不必每切
 *   一次就重编译，但绝不无界增长；
 * - **同源核对**：每份带 `source`（那一轮编译的正文）。宿主读到之后先比正文，正文不符
 *   （分屏的另一份同名文件 / 迟到的一轮）⇒ 当没有——不拿旧结论配新正文；
 * - 撤下（换标签 / 关文件 / 编译失败 / 卸载）由宿主调 `forget`：后台标签不保留 2.0 结论。
 *
 * 纯内存、零 IO；只依赖 `@kojo/kojo-core` 的类型。
 */
import type { KojoDiagnostic } from '@kojo/kojo-core';
import type { Kojo2DocumentArtifacts } from './diagnostics';

/** 一份诊断编译的成品快照（插件写、宿主读） */
export interface Kojo2DiagnosticResultSnapshot {
  /** 这一轮编译对应的正文（宿主据此核对"是不是同一份"） */
  readonly source: string;
  /** core 原始诊断（方言体检按码筛；不让宿主从波浪线反推） */
  readonly diagnostics: readonly KojoDiagnostic[];
  /** 同一次编译的产物 + source map（成对；`null` = 没有可预览的字节） */
  readonly artifacts: Kojo2DocumentArtifacts | null;
  /** 编译入口抛错时的消息（`null` = 正常返回） */
  readonly error: string | null;
}

/** 保留的份数（远大于"同时开着的标签"，又小到不会留住一整天的产物） */
export const KOJO2_DIAGNOSTIC_RESULTS_LIMIT = 8;

const results = new Map<string, Kojo2DiagnosticResultSnapshot>();

/**
 * 路径归一（键口径）：分隔符统一 `/`；Windows 盘符路径统一小写。
 *
 * 不用 `pathKey`（契约层）：本包不认识 `@kojo/plugin-api`（一是分层，二是它运行时只该有
 * core 的类型面）。判据简单到不值得为它开一条依赖。
 */
function keyOf(filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const slashed = filePath.replace(/\\/g, '/');
  return /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
}

/** 记下这一份（同一路径覆盖；超上限从最久未记的那份开始丢） */
export function rememberKojo2DiagnosticResult(
  filePath: string,
  snapshot: Kojo2DiagnosticResultSnapshot,
): void {
  const key = keyOf(filePath);
  if (key === null) return;
  // 重插到队尾：Map 的插入序就是这里的 LRU，最近编译的那份最不容易被丢
  results.delete(key);
  results.set(key, snapshot);
  while (results.size > KOJO2_DIAGNOSTIC_RESULTS_LIMIT) {
    const oldest = results.keys().next();
    if (oldest.done) break;
    results.delete(oldest.value);
  }
}

/** 该路径**上一次**诊断编译的成品（没有 / 已撤下 ⇒ `null`） */
export function kojo2DiagnosticResultFor(filePath: string): Kojo2DiagnosticResultSnapshot | null {
  const key = keyOf(filePath);
  return key === null ? null : (results.get(key) ?? null);
}

/** 撤下这一份（不存在 = no-op） */
export function forgetKojo2DiagnosticResult(filePath: string): void {
  const key = keyOf(filePath);
  if (key !== null) results.delete(key);
}

/** 全部撤下（卸载 / 换项目） */
export function clearKojo2DiagnosticResults(): void {
  results.clear();
}

/** 当前留了几份（观测面：有界性的读数） */
export function kojo2DiagnosticResultCount(): number {
  return results.size;
}