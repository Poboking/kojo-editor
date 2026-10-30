/**
 * 右键「语言族」项的判据面（ERB-PARITY G8）。
 *
 * G8 的原始缺陷：`use-monaco-instance.ts` 里一枚手写名单
 * `[ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]` 同时当"快速修复 / 一键修复 / 看这一行的状态 /
 * 切换 .kojo 预览"的 when 判据——① 2.0 漏在外面（`.kojo` 里三项根本不出现）；
 * ② 宿主加一门语言要改这枚常量，与"新增语言 = 加一枚 descriptor"的纪律相反。
 *
 * 本文件钉的就是收口后的形状：判据**只从 descriptor 派生**，
 * 新增一门声明了该能力的语言时右键项自动出现、宿主目录零改动。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EDITOR_CONTEXT_FACE_IDS,
  languageDescriptors,
  languageIdsForContextFace,
  lineCommentForLanguageId,
  lineCommentLanguageIds,
  registerLanguage,
  type EditorContextFaceId,
} from '../src/monaco/language-registry';
// 语言表 = 唯一装配点（四枚内置 descriptor 在这里登记）
import '../src/monaco/languages';
import { ERB_LANGUAGE_ID } from '../src/monaco/erb-language';
import { KOJO_LANGUAGE_ID } from '../src/monaco/kojo-language';
import { KOJO2_LANGUAGE_ID } from '@kojo/kojo-lang/constants';
import {
  languageFamilyWhen,
  listAllEditorContextActions,
} from '../src/ui/editor-pane/editor-context-actions';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = path.resolve(HERE, '../src');

describe('族级右键项：判据从 descriptor 派生（G8）', () => {
  it('三项方言动作在 ERB / kojo1 / 2.0 三门语言都在册（2.0 不再被漏掉）', () => {
    for (const face of ['quick-fix', 'fix-all', 'jump-to-state'] as const) {
      expect(languageIdsForContextFace(face), face).toEqual([
        ERB_LANGUAGE_ID,
        KOJO_LANGUAGE_ID,
        KOJO2_LANGUAGE_ID,
      ]);
    }
  });

  it('「切换 .kojo 预览」只声明给 ERB / kojo1（2.0 没有 v1 糖视图投影面，如实不声明）', () => {
    expect(languageIdsForContextFace('toggle-sugar')).toEqual([ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID]);
  });

  it('declaration 是"有"不是"想要"：每项 face 都对应表里一条真实动作', () => {
    const actionIds = new Set(listAllEditorContextActions().map((action) => action.id));
    for (const face of EDITOR_CONTEXT_FACE_IDS) {
      expect(actionIds.has(face), `face "${face}" 不是一条真实动作 id`).toBe(true);
    }
  });

  it('空表 ⇒ when 恒假（不能落空串：Monaco 里空 precondition 等于恒成立）', () => {
    expect(languageFamilyWhen([])).toBe('false');
    expect(languageFamilyWhen(['kojo-erb', 'kojo2'])).toBe(
      "editorLangId == 'kojo-erb' || editorLangId == 'kojo2'",
    );
  });

  it('新增一门声明了该能力的语言 ⇒ 列表与 when 自动带上它，宿主目录零改动', () => {
    const NEW_ID = 'family-test-lang';
    registerLanguage({
      id: NEW_ID,
      label: '族测语言',
      matchesPath: (filePath) => filePath.endsWith('.familytest'),
      register: () => undefined,
      contextFaces: ['quick-fix'],
      lineComment: ';',
    });
    // 声明了哪一项就只出现哪一项（不按"门"整把撒）
    expect(languageIdsForContextFace('quick-fix')).toContain(NEW_ID);
    expect(languageIdsForContextFace('fix-all')).not.toContain(NEW_ID);
    const when = languageFamilyWhen(languageIdsForContextFace('quick-fix'));
    expect(when).toContain(`editorLangId == '${NEW_ID}'`);
    // 行注释面的注册列表同样自己长出来（G9 的注册面是同一格派生）
    expect(lineCommentLanguageIds()).toContain(NEW_ID);
    expect(lineCommentForLanguageId(NEW_ID)).toBe(';');
  });
});

describe('宿主侧不再手写语言 id 名单（G8 的"零改动"判据）', () => {
  const source = readFileSync(
    path.join(APP_SRC, 'ui/editor-pane/use-monaco-instance.ts'),
    'utf8',
  );

  it('when 由 descriptor 派生（`languageIdsForContextFace` + `languageFamilyWhen`）', () => {
    expect(source).toMatch(/languageIdsForContextFace\(face\)/);
    expect(source).toMatch(/whenOfFace\('(quick-fix|fix-all|jump-to-state|toggle-sugar)'\)/);
    expect(source).toMatch(/languageFamilyWhen\(/);
  });

  it('没有回退成手写语言 id 名单（兜底= 那枚名单会重新漏掉后来加的语言）', () => {
    expect(source).not.toMatch(/const KOJO_FAMILY_LANGUAGE_IDS: readonly string\[\]/);
    expect(source).not.toMatch(/editorLangId == '\$\{/);
  });

  it('每门语言的族级声明都真的落在 descriptor 上的同一格（不另开第二张表）', () => {
    const familyDeclarations = languageDescriptors().filter(
      (descriptor) => (descriptor.contextFaces?.length ?? 0) > 0,
    );
    const declared = familyDeclarations.map((descriptor) => descriptor.id);
    // 三门内置语言在册（同文件里有测试会追加一门合成语言，故用包含而非全等）
    for (const id of [ERB_LANGUAGE_ID, KOJO_LANGUAGE_ID, KOJO2_LANGUAGE_ID]) {
      expect(declared).toContain(id);
    }
    for (const descriptor of familyDeclarations) {
      for (const face of descriptor.contextFaces ?? []) {
        expect(EDITOR_CONTEXT_FACE_IDS).toContain(face as EditorContextFaceId);
      }
    }
  });
});