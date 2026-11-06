/**
 * 引擎名字尺（D01b，2026-11-06）：「Emuera 把这一串字符读作**一枚**名字」的判据，
 * **全仓唯一一份定义**（守门测试＝`packages/plugin-api/tests/erb-name-ruler-single-source.test.ts`）。
 *
 * ## 为什么住契约层、而且是**零 import 的叶子**
 *
 * 宿主（改名台账 / 引用面板，`packages/app/**`）与插件（`erb-parser` 的未定义名腿）都要按
 * **同一把尺**取词；而解耦审计 B/C 禁插件间交叉 import、内核零游戏知识 ⇒ 跨边界共享判据的
 * 唯一合法落点就是契约层（与 `eol.ts` / `erb-vocab` 同一成例：上提到零依赖叶子，原住处只
 * `re-export`）。
 *
 * **为什么是子路径 `@kojo/plugin-api/erb-name-ruler` 而不是根入口**：本文件被
 * `packages/plugins/erb-parser/src/scanner.ts` 再导出，而 scanner 由
 * `packages/erb-syntax-tree/tools/gen-erb-structure.mjs` 用**裸 node** 动态 import——
 * 指向 plugin-api **根入口**的值导入会真的去加载 `src/index.ts`，它内部是无扩展名相对导入
 * ⇒ 裸 node 直接崩。故本文件必须保持**零 import**，并在 plugin-api 的 `exports` 里单独开一格
 * （与 `./eol` 逐字同形）。
 *
 * ## 与 `semantic-locate.ts` 的 `MODEL_TOKEN_CLASS` 是**两把尺、两个问题**，不许合并
 *
 * - `MODEL_TOKEN_CLASS`（`[\p{L}\p{N}_]`）答的是「**着色 / 补全**把哪个字符范围当一个记号」——
 *   记号尺，服务编辑器外观与函数记号查表；
 * - 本文件答的是「**引擎**读一个变量名时读到哪为止」——名字段尺，服务引用判据与改名台账。
 *
 * 把 `MODEL_TOKEN_CLASS` 改成引擎尺＝同时打坏着色与改名两条链（引擎的 `.` `~` `?` `#` `$` `@`
 * 一旦进记号集，`FORM_P0` 与 `P0` 会连成一坨）；反过来把本尺收窄成记号尺＝`P23温泉·更衣间`
 * 在 `·`(U+00B7) 处被劈成两段，引擎眼里的一枚名字在编辑器里变两枚。故两把尺**并存**是设计，
 * 不是债；守门测试里有一条专门钉「两把尺的字符类不相等」。
 *
 * ## 分隔集的真源
 *
 * 引擎 `Emuera/Runtime/Script/Parser/LexicalAnalyzer.cs` 的 `_searchValues`，**逐码位抄录**，
 * 一字符不许多、不许少。`ReadSingleIdentifierROS` 就是「读到任一分隔符为止」⇒
 * **引擎眼里的名字 = 不含下列字符的极大段**。
 *
 * 注意引擎这串里 `.` `~` `?` `#` `$` `@` **是**分隔符、反引号 **不是**；
 * 非 ASCII 只列了全角空格 `\u3000`（半角空格与制表也在内）。与声明侧排除集的逐字符差异
 * 由 `erb-parser/tests/undefined-name.drift.test.ts` 钉死，不许静默漂移。
 */

export const ERB_ENGINE_NAME_DELIMITERS = ' \t　.+-*/%=!<>|&^~?#)}],:({[$\'"@;';

/** 引擎分隔集的 ASCII 查表位（由上面那一串填出，不另抄） */
const ENGINE_DELIM_ASCII = new Uint8Array(128);
/** 引擎分隔集里的非 ASCII 码位（由上面那一串填出；现只有 `\u3000`） */
const ENGINE_DELIM_EXTRA = new Set<number>();
for (const ch of ERB_ENGINE_NAME_DELIMITERS) {
  const code = ch.codePointAt(0)!;
  if (code < 128) ENGINE_DELIM_ASCII[code] = 1;
  else ENGINE_DELIM_EXTRA.add(code);
}

/**
 * 引擎口径的**名字字符**判据（码位；未定义名腿切记号用的就是它）。
 *
 * `NaN` = 空串上的 `charCodeAt(0)`：不是字符，也就不是名字字符。
 */
export function isErbEngineNameCode(code: number): boolean {
  if (!Number.isFinite(code)) return false;
  if (code < 128) return ENGINE_DELIM_ASCII[code] === 0;
  return !ENGINE_DELIM_EXTRA.has(code);
}

/** 由同一串真源组装的正则字符类（`u` 旗安全：控制码位与非 ASCII 一律写 `\uXXXX`） */
function engineNameClassSource(): string {
  let out = '[^';
  for (const ch of ERB_ENGINE_NAME_DELIMITERS) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code > 0x7e ? `\\u${code.toString(16).padStart(4, '0')}` : /[\\\]^[-]/.test(ch) ? `\\${ch}` : ch;
  }
  return `${out}]`;
}

/**
 * 名字段的**正则形态**（与 {@link isErbEngineNameCode} 同源的另一个出口）：
 * `new RegExp(ERB_NAME_RUN_SOURCE + '+', 'gu')` 切出来的段 = 引擎读到的极大名字段。
 * 需要正则的消费方**只许**引这一枚，再写一遍字符类就是第二判据。
 */
export const ERB_NAME_RUN_SOURCE = engineNameClassSource();
