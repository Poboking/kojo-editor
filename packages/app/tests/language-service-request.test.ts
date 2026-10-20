/**
 * LANG-CONTRACT（2026-10-20）的宿主侧钉子：文档型语言服务请求必须带**模型身份**。
 *
 * 钉三件事：
 * ① `languageId` / `version` 原样来自 model——宿主不按扩展名猜语言、不自造版本号；
 * ② `text` / `lineCount` 取自**传进来的那份 model**（糖面传原文 model 时行号才是源坐标，
 *    宿主不拿屏幕上的投影重新数行）；
 * ③ 请求发出后 model 再变一次，`version` 就对不上——这是异步产出落地前"整批丢弃重问"
 *    的唯一判据（同步的 `provide` 没有在途响应，契约不发明取消令牌）。
 */
import { describe, expect, it } from 'vitest';
import type * as Monaco from 'monaco-editor';
import { documentRequestFields } from '../src/ui/language-service-request';

interface FakeModelOptions {
  readonly text?: string;
  readonly languageId?: string;
  readonly version?: number;
  readonly lineCount?: number;
}

function fakeModel(options: FakeModelOptions = {}): {
  readonly model: Monaco.editor.ITextModel;
  edit: () => void;
} {
  let version = options.version ?? 1;
  const model = {
    getValue: () => options.text ?? '',
    getLineCount: () => options.lineCount ?? 1,
    getLanguageId: () => options.languageId ?? 'plaintext',
    getVersionId: () => version,
  } as unknown as Monaco.editor.ITextModel;
  return { model, edit: () => { version += 1; } };
}

describe('documentRequestFields', () => {
  it('语言与版本原样来自 model，不从 path 扩展名推断', () => {
    const { model } = fakeModel({ languageId: 'kojo', version: 7 });
    const fields = documentRequestFields(model, '/t/story.erb', null);
    expect(fields.path).toBe('/t/story.erb');
    expect(fields.languageId).toBe('kojo');
    expect(fields.version).toBe(7);
  });

  it('text 与 lineCount 取自传进来的 model（不重新数行）', () => {
    const { model } = fakeModel({
      text: '@A\n第二行',
      lineCount: 52_601,
      languageId: 'erb',
      version: 3,
    });
    const fields = documentRequestFields(model, '/t/A.erb', null);
    expect(fields.text).toBe('@A\n第二行');
    expect(fields.lineCount).toBe(52_601);
    expect(fields.languageId).toBe('erb');
  });

  it('project 引用原样传递（null 也是事实，不省略成 undefined）', () => {
    const { model } = fakeModel();
    expect(documentRequestFields(model, '/t/A.erb', null).project).toBeNull();
  });

  it('请求发出后 model 再变 ⇒ 请求里的 version 已过期', () => {
    const { model, edit } = fakeModel({ version: 3 });
    const fields = documentRequestFields(model, '/t/A.erb', null);
    edit();
    expect(fields.version).toBe(3);
    expect(model.getVersionId()).toBe(4);
    expect(fields.version).not.toBe(model.getVersionId());
  });
});
