/**
 * 文档型语言服务请求的**取数单一入口**（LANG-CONTRACT，2026-10-20）。
 *
 * 宿主有十来条腿（定义 / 引用 / 大纲 / 折叠 / 注解 / 提示 / 着色 / 改名）各自构造请求，
 * 共同字段此前逐处手抄。抄漏 `languageId` / `version` 不会立刻报错——只会在语言注册表
 * 分派或异步结果复核时静默失准，所以收成一个纯函数并由契约测试钉住：
 * - `text` / `lineCount` 取**传进来的这份 model**（糖面传原文 model，行号才是源坐标）；
 * - `languageId` / `version` 原样取 model，宿主不猜、不改写；
 * - `path` 由调用方给（糖面给原文路径，语义着色给投影路径），本函数不替它换算。
 */
import type * as Monaco from '../monaco/entry';
import type { GameProject } from '@kojo/plugin-api';

export interface DocumentRequestFields {
  readonly path: string;
  readonly text: string;
  readonly project: GameProject | null;
  readonly lineCount: number;
  readonly languageId: string;
  readonly version: number;
}

export function documentRequestFields(
  model: Monaco.editor.ITextModel,
  path: string,
  project: GameProject | null,
): DocumentRequestFields {
  return {
    path,
    text: model.getValue(),
    project,
    lineCount: model.getLineCount(),
    languageId: model.getLanguageId(),
    version: model.getVersionId(),
  };
}
