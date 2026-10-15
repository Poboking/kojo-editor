/**
 * B 档保留面：`.json` 高亮自写微型 Monarch（`docs/BOARD.md` §D「文件类型保留面」B 档）。
 *
 * 为什么不引 `monaco-editor/languages/features/json/**`：那是带 ~400 KB worker 的
 * 重型 feature（json.worker 做校验 / 补全 / 格式），而语料实测 `.json` 命中 1 份 ⇒
 * 保留面收窄为「够看」：键 / 字符串 / 数字 / 字面量 / 括号分隔五类着色，
 * **无 worker、无校验**（诊断由各插件自己的通道给，不假手 Monaco 语言服务）。
 *
 * 语言 id 用 Monaco 惯用的 `json`（与扩展名 `.json` 的自动识别对齐）；`kind` 下的
 * `variable` / `string` / `number` / `keyword` 均为 `kojo-dark` 主题已有着色规则
 * （`erb-language.ts` 的 defineTheme），不新增第二份主题面。
 */
import type * as Monaco from './entry';

export const JSON_LANGUAGE_ID = 'json';

/** 注册进宿主（幂等：已在则跳过——与 erb / kojo 两个 register 同款守卫） */
export function registerJsonLanguage(monaco: typeof Monaco): void {
  if (monaco.languages.getLanguages().some((l) => l.id === JSON_LANGUAGE_ID)) return;

  monaco.languages.register({
    id: JSON_LANGUAGE_ID,
    extensions: ['.json'],
    aliases: ['JSON', 'json'],
  });

  monaco.languages.setMonarchTokensProvider(JSON_LANGUAGE_ID, {
    tokenizer: {
      root: [
        // 键：引号串 + 前瞻冒号（比 `"x":` 与值 `"x"` 分色）
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'variable'],
        [/"(?:[^"\\]|\\.)*"/, 'string'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\],:]/, 'delimiter'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  monaco.languages.setLanguageConfiguration(JSON_LANGUAGE_ID, {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });
}
