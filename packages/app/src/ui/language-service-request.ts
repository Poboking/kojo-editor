/**
 * 文档型语言服务请求的**取数单一入口**（LANG-CONTRACT，2026-10-20）。
 *
 * 宿主有十来条腿（定义 / 引用 / 大纲 / 折叠 / 注解 / 提示 / 着色 / 改名）各自构造请求，
 * 共同字段此前逐处手抄。抄漏 `languageId` / `version` 不会立刻报错——只会在语言注册表
 * 分派或异步结果复核时静默失准，所以收成一个纯函数并由契约测试钉住：
 * - `text` / `lineCount` 取**传进来的这份 model**（糖面传原文 model，行号才是源坐标）；
 * - `languageId` / `version` 原样取 model，宿主不猜、不改写；
 * - `path` 由调用方给（糖面给原文路径，语义着色给投影路径），本函数不替它换算。
 *
 * LAU-D1b（2026-10-27）：这一枚也是 `EditorDocumentIdentity.dialect?` 的**唯一构造点**——
 * 解析好的方言上下文随每次文档型请求一起下传（additive；未绑定 ⇒ 键不出现，既有供方
 * 零改动）。解析本身在 `dialect-binding.ts`，本函数只把结果装进身份里。
 */
import type * as Monaco from '../monaco/entry';
import type { DialectContext, GameProject } from '@kojo/plugin-api';
import { dialectContextOf, resolveDocumentDialect } from './dialect-binding';

export interface DocumentRequestFields {
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly lineCount: number;
  readonly languageId: string;
  readonly version: number;
  /** 方言上下文（LAU-D1b）：缺省 = 未绑定（供方按无事实降级，不许回落默认方言） */
  readonly dialect?: DialectContext;
}

export function documentRequestFields(
  model: Monaco.editor.ITextModel,
  path: string,
  project: GameProject | null,
): DocumentRequestFields {
  const fields = {
    path,
    text: model.getValue(),
    project,
    lineCount: model.getLineCount(),
    languageId: model.getLanguageId(),
    version: model.getVersionId(),
  };
  const dialect = dialectContextOf(
    resolveDocumentDialect({
      project,
      source: fields.text,
      filePath: path,
      version: fields.version,
    }),
  );
  // 未绑定 / 响应对不上 ⇒ 连键都不出现：`undefined` 是契约里的"未绑定"，不是"空方言"
  return dialect === null ? fields : { ...fields, dialect };
}
