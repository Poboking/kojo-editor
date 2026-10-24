/**
 * 口上 XML 语言面（`kojo-xml`）——Monarch 高亮 + 语言配置。
 *
 * 为什么自写微型 Monarch 而不引 Monaco 的 XML 扩展：与 `.json` 那条同一个理由
 * （`json-language.ts` 头注）——Monaco 的 xml feature 是带 worker 的重型包，
 * 而口上 XML 要的只是"看得清 + 能折叠 + 属性名有颜色"。诊断由我们自己的通道给
 * （`kojo-xml-diagnostics.ts`），不假手 Monaco 语言服务。
 *
 * **不声明 `languageServices`**：`register-dialects.ts` 会给所有声明了它的语言
 * 双注册 ERB/kojo 那 11 枚 provider；XML 吃进来只会拿一堆空结果顶掉 Monaco
 * 内建的缩进折叠与括号行为。XML 的 provider 由本文件末尾自己挂。
 *
 * 配色只用**已有 token 名**（`keyword` / `variable` / `string` / `operator` /
 * `string.escape`）：主题的 token 集合是三套调色板钉死的单一真源，新造 token 名
 * 会让亮色 / 墨绿两套主题当场缺色（`rulesFromPalette` 的抛错判据）。
 */
import type * as Monaco from './entry';
import { registerKojoXmlDiagnostics } from './kojo-xml-diagnostics';
import { registerKojoXmlProviders } from './kojo-xml-providers';

export const KOJO_XML_LANGUAGE_ID = 'kojo-xml';
/** 口上 XML 的扩展名（认路判据与 Monaco 注册共用） */
export const KOJO_XML_SOURCE_EXTENSION = '.xml';

/** 幂等守卫：`registerAllLanguageSurfaces` 可能被多次触发 */
let registered = false;

export function registerKojoXmlLanguage(monaco: typeof Monaco): void {
  if (registered) return;
  if (monaco.languages.getLanguages().some((l) => l.id === KOJO_XML_LANGUAGE_ID)) {
    registered = true;
    return;
  }
  registered = true;

  monaco.languages.register({
    id: KOJO_XML_LANGUAGE_ID,
    extensions: [KOJO_XML_SOURCE_EXTENSION],
    aliases: ['口上 XML', 'Kojo XML', 'xml'],
  });

  monaco.languages.setMonarchTokensProvider(KOJO_XML_LANGUAGE_ID, {
    defaultToken: '',
    tokenPostfix: '',
    // `%CALLNAME:X%` / `[$MNAME]` 是台词里的替换记号，不是 XML 结构；
    // 给它们上色是因为作者最常在这一层写错（少一个 `%` 整句就原样打出来）。
    tokenizer: {
      root: [
        [/<\?[\s\S]*?\?>/, 'comment'],
        [/<!--/, 'comment', '@comment'],
        [/<!\[CDATA\[/, 'string', '@cdata'],
        [/(<\/?)([A-Za-z_][\w.:-]*)/, ['operator', 'keyword'], '@tag'],
        [/%[^%\r\n]{1,64}%/, 'variable'],
        [/\[\$[A-Za-z_][\w.:-]*\]/, 'variable'],
        [/&[A-Za-z#][\w#]{0,8};/, 'string.escape'],
      ],
      tag: [
        [/([A-Za-z_][\w.:-]*)(\s*)(=)(\s*)("[^"]*"|'[^']*')/, [
          'variable',
          '',
          'operator',
          '',
          'string',
        ]],
        [/\s*(\/?>)/, ['', 'operator'], '@pop'],
        [/\s+/, ''],
      ],
      comment: [
        [/[^-]+/, 'comment'],
        [/-->/, 'comment', '@pop'],
        [/-/, 'comment'],
      ],
      cdata: [
        [/[^\]]+/, 'string'],
        [/\]\]>/, 'string', '@pop'],
        [/\]/, 'string'],
      ],
    },
  } as Monaco.languages.IMonarchLanguage);

  monaco.languages.setLanguageConfiguration(KOJO_XML_LANGUAGE_ID, {
    comments: { blockComment: ['<!--', '-->'] },
    // 尖括号不进 `brackets`：XML 的 `<`/`>` 不是可嵌套结构，配对高亮会一路串色；
    // 引号也不进（只进自动闭合/包裹）。
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '{', close: '}' },
      { open: '<', close: '>' },
    ],
    surroundingPairs: [
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '{', close: '}' },
    ],
    // 折叠走自建 provider（按标签配对），不依赖缩进；这里的标记只为"折叠控件可见"
    folding: { markers: { start: /^\s*<!--\s*#?region/, end: /^\s*<!--\s*#?endregion/ } },
    wordPattern: /(-?\d*\.\d\w*)|([^\s<>"'=]+)/g,
  });

  // 增强面（悬停 / 补全 / 大纲 / 折叠）与诊断面：各自幂等
  registerKojoXmlProviders(monaco);
  registerKojoXmlDiagnostics(monaco);
}
