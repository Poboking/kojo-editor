import type * as Monaco from './entry';
import { snippetsForLanguage, type UserSnippet } from '../ui/user-snippets';

/**
 * 用户片段的 **Monaco 补全接线**（S10）：把 `ui/user-snippets.ts` 存下的片段表变成
 * `InsertAsSnippet` 候选。
 *
 * 分工：存储 / 校验 / 分组全在 UI 层（零 Monaco）；本文件只做两件事——
 * ①正文按 Monaco snippet 语法**原样**下发（`$1` / `${1:name}` / `${1|甲,乙|}` 的占位符
 * 跳转由 Monaco 自己处理，本层不重新编号、不转义作者的 `$`）；
 * ②按语言 id 过滤 + 组装候选。**不在这里注册**到任何全局 provider 表——组长接线时
 * 调 `install(monaco)` 或把 `buildItems` 合进现有装配，二选一，本模块不抢装配权。
 *
 * 正文只归一换行（`\r\n` / `\r` → `\n`）：模型里插入的文本一律 LF，留 CR 会在插出后
 * 与周边行制造 diff 噪声；除此之外一个字符都不动。
 */

/** 片段正文 → Monaco snippet insertText（换行归一；snippet 语法原样交给 Monaco） */
export function toMonacoSnippetText(body: string): string {
  return body.replace(/\r\n?/g, '\n');
}

/** 供组长接线的片段 provider（语言 id 列表在创建时定死，片段表可随时刷新） */
export interface UserSnippetProvider {
  /** 创建时声明的语言 id（只给这些语言出候选） */
  readonly languages: readonly string[];
  /** 片段表更新入口：存储加载 / CRUD 保存后调用 */
  setSnippets(snippets: readonly UserSnippet[]): void;
  /** 当前片段表只读快照 */
  snippets(): readonly UserSnippet[];
  /** 某个语言的候选（`languageId` 不在声明列表里 ⇒ 空数组） */
  buildItems(monaco: typeof Monaco, languageId: string, range: Monaco.IRange): Monaco.languages.CompletionItem[];
  /** 直接注册到 Monaco：声明列表里每个语言一个 provider（返回可释放句柄） */
  install(monaco: typeof Monaco): Monaco.IDisposable[];
}

/**
 * 建时选项（additive）：把**片段分组键**（作者侧 `erb` / `kojo2`）落到 Monaco **语言 id**。
 * 缺省恒等，既有调用零改动；宿主接线时传 `erb → kojo-erb` 的映射。
 */
export interface UserSnippetProviderOptions {
  /** 片段分组键 → Monaco 语言 id；缺省原样返回 */
  readonly languageIdFor?: (snippetLanguage: string) => string;
}

/**
 * 建一枚片段 provider。
 *
 * `languageIds` 是**片段分组键**（本版 = `erb` / `kojo2`，与存储里的 `language` 同字）；
 * Monaco 语言 id 由 {@link UserSnippetProviderOptions.languageIdFor} 映射（缺省恒等）。
 * 不在列表里的语言一律零候选——片段表里就算有别的语言分组，本 provider 也不替它出货。
 */
export function createUserSnippetProvider(
  languageIds: readonly string[],
  options: UserSnippetProviderOptions = {},
): UserSnippetProvider {
  // 片段分组键（作者侧，`ui/user-snippets.ts` 的 `erb` / `kojo2`）与 Monaco 语言 id 是两套：
  // ERB 在 Monaco 里叫 `kojo-erb`。`languageIdFor` 缺省恒等（既有调用 / 测试零改动）。
  const groups = [...new Set(languageIds)];
  const idOf = (group: string): string => options.languageIdFor?.(group) ?? group;
  const languages = [...new Set(groups.map(idOf))];
  let current: readonly UserSnippet[] = [];

  /** Monaco 语言 id → 片段分组键（不在声明里 ⇒ `null`，这枚 provider 不出候选） */
  const groupOf = (languageId: string): string | null =>
    groups.find((group) => idOf(group) === languageId) ?? null;

  const buildItems: UserSnippetProvider['buildItems'] = (monaco, languageId, range) => {
    const group = groupOf(languageId);
    if (group === null) return [];
    // 常量对象防御性读取（测试桩 / 旧运行时可能不挂 CompletionItemInsertTextRule）
    const kind = monaco.languages.CompletionItemKind.Snippet;
    const rule = monaco.languages.CompletionItemInsertTextRule?.InsertAsSnippet;
    return snippetsForLanguage(current, group).map((s) => ({
      label: s.prefix,
      kind,
      insertText: toMonacoSnippetText(s.body),
      ...(rule !== undefined ? { insertTextRules: rule } : {}),
      detail: s.name,
      ...(s.description !== undefined ? { documentation: s.description } : {}),
      filterText: s.prefix,
      // 用户片段排在语言内置候选之前（作者自己定义的模板优先级最高）
      sortText: `0_user_${s.prefix}`,
      range,
    }));
  };

  return {
    languages,
    setSnippets(snippets) {
      current = [...snippets];
    },
    snippets() {
      return [...current];
    },
    buildItems,
    install(monaco) {
      const disposables: Monaco.IDisposable[] = [];
      for (const languageId of languages) {
        disposables.push(
          monaco.languages.registerCompletionItemProvider(languageId, {
            provideCompletionItems: (model, position) => {
              const word = model.getWordUntilPosition(position);
              const range: Monaco.IRange = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
              };
              return { suggestions: buildItems(monaco, languageId, range) };
            },
          }),
        );
      }
      return disposables;
    },
  };
}
