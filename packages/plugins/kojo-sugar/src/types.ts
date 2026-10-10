/**
 * 转译器内部类型（非契约；消费者只用 `plugin-api/sugar.ts`）。
 */

import type { AliasValue, SugarDiagnostic } from '@kojo/plugin-api';

/** 别名表条目（含只读性——`isReadonlyAlias` 的镜像，避免每次重新判定） */
export interface AliasEntry {
  value: AliasValue;
  /** 只读 = 角色引用 / 字面量（规范 §3.1 表） */
  readonly: boolean;
  /** 声明处所在源行（诊断与源映射用） */
  line: number;
}

/** 文件级别名表（规范 §3.1 ③：不跨文件） */
export type AliasTable = ReadonlyMap<string, AliasEntry>;

/**
 * 变量字典查询（由 game adapter 提供；转译器只消费，不解释游戏知识）。
 *
 * - `resolveFamily(name)`：给定变量**名字**（中文/日文/英文均可），返回所属
 *   变量族（`CFLAG` / `TALENT` / `ABL` / …）；未收录 → undefined
 *   （用于 `她的X` 属性解析）；
 * - `resolve(ident)`：给定**裸标识符**（如作者写的 `DAY` / `TFLAG:193`），
 *   返回可直接嵌入 ERB 的原文；未收录 → undefined
 *   （用于正文裸标识符）。
 */
export interface DictionaryLookup {
  resolveFamily(name: string): string | undefined;
  resolve(ident: string): string | undefined;
}

/** 诊断收集器（parse 与 codegen 共用；保证 `internal` 绝不静默） */
export interface DiagnosticSink {
  report(diag: SugarDiagnostic): void;
  /** 已收集的诊断（按源位置排序由调用方负责） */
  all(): SugarDiagnostic[];
}
