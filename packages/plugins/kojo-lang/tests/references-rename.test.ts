/**
 * B3e 引用 / 改名两条腿的供方闸（`src/references.ts` + `src/rename.ts` + `plugin.ts` 接线）。
 *
 * 判据本体在 `packages/kojo-lang/tests/references.test.ts` / `rename.test.ts` /
 * `rename-xfile.test.ts`；本文件只钉**供方那一层**：
 * 1. **语言过滤**：非 kojo2 ⇒ `undefined`（弃权）——混成空结果会把宿主那门语言自己的供方顶掉；
 * 2. **快照缺席 = 同文件**：`projectFiles` 不给时，引用只答本篇、改名的 `resourcePath` 缺省；
 * 3. **跨文件合并 / 排序 / 去重**：`projectFiles` 给出时落点带 `filePath`（引用）/ 编辑带
 *    `resourcePath`（改名），与包的跨文件判据同一份结果；
 * 4. **上限与如实降级**：`projectFilesComplete === false` ⇒ 引用 `truncated: true`，
 *    改名整次拒绝并给作者可读理由；
 * 5. **改名全或无**：非法新名 / 重名 / 表达式 token 失败 / parse 复查失败 ⇒ 零编辑 + 理由；
 * 6. **零游戏事实**：两条腿都不取 adapter（没有 project 也照给），`order` 与既有供方相同。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLanguageServiceContribution, PluginContext } from '@kojo/plugin-api';
import { createKojoLangPlugin, provideReferences, provideRename } from '../src/index';

const PATH = 'D:/proj/口上/1_测试.kojo2';
const OTHER = 'D:/proj/口上/2_共用.kojo2';

/** 请求文件：事件声明 + 表声明 + 插值引用（`# 机` 让正文有挂点，parse 零 error） */
const SOURCE = [
  '# 机 指令 310', // 1
  '# 对照表 心情 依据 1', // 2
  '> 她今天看起来{心情}。', // 3
].join('\n');

/** 别的文件：同一张表的声明 + 引用（跨文件形态） */
const OTHER_SOURCE = [
  '# 机 指令 310', // 1
  '# 对照表 心情 依据 1', // 2
  '> {心情}', // 3
].join('\n');

function referencesRequest(over: Record<string, unknown> = {}) {
  return {
    kind: 'references' as const,
    path: PATH,
    text: SOURCE,
    line: 3,
    column: 10,
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

function renameRequest(over: Record<string, unknown> = {}) {
  return {
    kind: 'rename' as const,
    path: PATH,
    text: SOURCE,
    line: 2,
    column: 7,
    newName: '情绪',
    project: null,
    languageId: 'kojo2',
    ...over,
  } as never;
}

function activate(): Map<string, EditorLanguageServiceContribution> {
  const contributions = new Map<string, EditorLanguageServiceContribution>();
  const ctx = {
    pluginId: 'kojo-lang',
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    slots: {
      register: (slot: string, item: EditorLanguageServiceContribution) => {
        if (slot === 'ui.editor.languageService') contributions.set(item.id, item);
        return () => undefined;
      },
    },
  } as unknown as PluginContext;
  createKojoLangPlugin().activate(ctx);
  return contributions;
}

/* ============================== ① 语言过滤 ============================== */

describe('语言过滤：只答 kojo2（其余弃权，不是空结果）', () => {
  it('kind 不对 / languageId 不是 kojo2 / 扩展名不是 2.0 ⇒ undefined', () => {
    expect(provideReferences({ kind: 'hover', path: PATH, text: '', line: 1, column: 1, project: null } as never)).toBeUndefined();
    expect(provideReferences(referencesRequest({ languageId: 'erb' }))).toBeUndefined();
    expect(provideRename({ kind: 'hover', path: PATH, text: '', line: 1, column: 1, project: null } as never)).toBeUndefined();
    expect(provideRename(renameRequest({ languageId: 'erb' }))).toBeUndefined();
    const noLanguage = { ...(renameRequest() as object), languageId: undefined, path: 'D:/p/a.erb' } as never;
    expect(provideRename(noLanguage)).toBeUndefined();
  });
});

/* ============================== ② 快照缺席 = 同文件 ============================== */

describe('projectFiles 缺席：只答请求文件这一篇', () => {
  it('引用：落点全部落在 request.path（没有跨文件 filePath）', () => {
    const result = provideReferences(referencesRequest())!;
    expect(result.kind).toBe('references');
    expect(result.locations.map((location) => location.filePath)).toEqual([PATH, PATH]);
    expect(result.locations.map((location) => location.kind)).toEqual(['definition', 'mention']);
    expect(result.truncated).toBeUndefined();
  });

  it('改名：编辑缺省 `resourcePath`（宿主按 model.uri 落地），oldName 交回', () => {
    const result = provideRename(renameRequest())!;
    expect(result.kind).toBe('rename');
    expect(result.oldName).toBe('心情');
    expect(result.edits).toHaveLength(2);
    expect(result.edits.every((edit) => edit.resourcePath === undefined)).toBe(true);
    expect(result.edits.every((edit) => edit.newText === '情绪')).toBe(true);
  });
});

/* ============================== ③ 跨文件合并 ============================== */

describe('projectFiles 给出：跨文件合并 / 排序 / 去重', () => {
  it('引用：别的文件声明 + 引用都带上 filePath；本文件用 request.path', () => {
    const result = provideReferences(
      referencesRequest({
        projectFiles: [{ path: OTHER, text: OTHER_SOURCE }],
        projectFilesComplete: true,
      }),
    )!;
    expect(result.locations.map((location) => `${location.filePath}:${location.kind}`)).toEqual([
      `${PATH}:definition`,
      `${OTHER}:definition`,
      `${PATH}:mention`,
      `${OTHER}:mention`,
    ]);
    // 同一位置不重复（OTHER 的声明位只出现一次）
    const keys = result.locations.map((location) => `${location.filePath}:${location.line}:${location.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('改名：跨文件编辑带 `resourcePath`（请求文件那份 = request.path，候选那份 = 候选路径）', () => {
    const result = provideRename(
      renameRequest({
        projectFiles: [{ path: OTHER, text: OTHER_SOURCE }],
        projectFilesComplete: true,
      }),
    )!;
    expect(result.edits).toHaveLength(4);
    expect(result.edits.filter((edit) => edit.resourcePath === PATH)).toHaveLength(2);
    expect(result.edits.filter((edit) => edit.resourcePath === OTHER)).toHaveLength(2);
  });
});

/* ============================== ④ 上限 / 如实降级 ============================== */

describe('快照不完整：引用如实标 truncated；改名全或无拒绝', () => {
  it('projectFilesComplete === false ⇒ 引用 truncated = true（落点照给）', () => {
    const result = provideReferences(
      referencesRequest({
        projectFiles: [{ path: OTHER, text: OTHER_SOURCE }],
        projectFilesComplete: false,
      }),
    )!;
    expect(result.locations.length).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it('projectFilesComplete === false ⇒ 改名零编辑 + 作者可读理由（含"不完整"）', () => {
    const result = provideRename(
      renameRequest({
        projectFiles: [{ path: OTHER, text: OTHER_SOURCE }],
        projectFilesComplete: false,
      }),
    )!;
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain('不完整');
  });
});

/* ============================== ⑤ 改名全或无 ============================== */

describe('改名全或无：四类失败都零编辑 + 理由', () => {
  it('非法新名', () => {
    const result = provideRename(renameRequest({ newName: '1坏名' }))!;
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain('合法');
  });

  it('与既有声明重名', () => {
    const text = '# 设 心情 整数 = 0\n# 设 情绪 整数 = 0';
    const result = provideRename(renameRequest({ text, line: 1, column: 6, newName: '情绪' }))!;
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain('已在本文件声明过');
  });

  it('表达式 token 失败 ⇒ 整次取消（宁可少改，不猜）', () => {
    // 一个无法词法化的表达式位（未闭合字符串会让 tokenizeExpr 报错）
    const text = '# 机 指令 310\n# 设 心情 整数 = 0\n@算\n    心情 = "未闭合';
    const result = provideRename(renameRequest({ text, column: 6 }))!;
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain('词法化');
  });

  it('复查 parse 出现 error ⇒ 零编辑', () => {
    const text = `${SOURCE}\n@断\n`;
    const result = provideRename(renameRequest({ text }))!;
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain('解析错误');
  });

  it('光标不在符号上 ⇒ 零编辑 + 位置理由（陈旧 / 越界坐标同一条路）', () => {
    const result = provideRename(renameRequest({ line: 999 }))!;
    expect(result.edits).toEqual([]);
    expect(result.rejectReason).toContain('不在本文件');
  });
});

/* ============================== ⑥ 注册纪律 ============================== */

describe('注册纪律：两条腿分枚注册、order 10、零游戏事实', () => {
  it('`kojo2-references` / `kojo2-rename` 各一枚，order 都是 10', () => {
    const contributions = activate();
    const ids = [...contributions.keys()].sort();
    expect(ids).toEqual([
      'kojo2-codeLens',
      'kojo2-completion',
      'kojo2-definition',
      'kojo2-documentHighlight',
      'kojo2-foldingRange',
      'kojo2-formatting',
      'kojo2-hover',
      'kojo2-inlay',
      'kojo2-references',
      'kojo2-rename',
      'kojo2-selectionRange',
      // B3 语义收口（`ffb65f83`）：语义着色供方入插件（槽 `ui.editor.languageService` 的
      // `semanticToken`）。它进的是"贡献 id 全集"快照，本用例钉的两条腿一字未动。
      'kojo2-semanticTokens',
      'kojo2-signatureHelp',
      'kojo2-symbols',
      'kojo2-workspaceSymbols',
    ]);
    expect(contributions.get('kojo2-references')!.order).toBe(10);
    expect(contributions.get('kojo2-rename')!.order).toBe(10);
  });

  it('没有 project / adapter 也照给（两条腿零游戏事实）', () => {
    const contributions = activate();
    const reference = contributions.get('kojo2-references')!.provide(referencesRequest()) as {
      locations: readonly unknown[];
    };
    expect(reference.locations).toHaveLength(2);
    const rename = contributions.get('kojo2-rename')!.provide(renameRequest()) as {
      edits: readonly unknown[];
    };
    expect(rename.edits).toHaveLength(2);
  });

  it('从装配面取到的供方与直调逐字相同（不另包一层判据）', () => {
    const contributions = activate();
    expect(contributions.get('kojo2-references')!.provide(referencesRequest())).toEqual(
      provideReferences(referencesRequest()),
    );
    expect(contributions.get('kojo2-rename')!.provide(renameRequest())).toEqual(
      provideRename(renameRequest()),
    );
  });
});
