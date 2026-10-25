/**
 * 落盘编码策略 —— **唯一陈述处**（2026-10-20 ENCODE-SS）。
 *
 * ## 它解决的问题
 *
 * 本仓有三条各自决定"写出去的是什么字节"的路，此前每条的编码口径只住在自己的
 * 实现注释里，没有一处把它们并排说清：
 *
 * 1. **编译产物**（`.kojo` → `.ERB`）：保存 / 部署 / 导出 ZIP 共用
 *    `kojo-sugar/src/compile.ts::encodeErbBytes`（`compileToBytes` 与 `compileToFile`
 *    同一条组装路，`lift-apply` 也复用同一个函数）；
 * 2. **起手包**（脚手架）：文本自己携带 BOM / 换行（角色表 CSV 由 adapter 拼出
 *    UTF-8-BOM + CRLF），`scaffold-writer.ts` 只做**逐字节**写（`writeBytes`），
 *    所以"文本没有前导 U+FEFF"就落成 BOM-less；
 * 3. **`exportFile`**（法定域外写通道）：**字节透明**——Rust 侧
 *    `std::fs::write(&picked, &bytes)` 原样落盘，不加 BOM、不转换行、不探测编码。
 *    编码全由调用方给的字节决定（ZIP 是二进制；"另存 `.kojo`" 由调用方自己补
 *    `U+FEFF` 与工作区新建文件同构；归档条目取出是原始字节）。
 *
 * ## 实测定下的策略（2026-10-20 本机，逐字节；守卫见
 * `tests/encoding-policy.test.ts` 的 ① 组，表的每一行都有对应的字节断言）
 *
 * | 路径 | BOM | 换行 | 末尾换行 |
 * |---|---|---|---|
 * | `compiled-product`（`.ERB` 产物） | **有**（`EF BB BF`） | **LF**（正文里的 CRLF/CR 一律归一） | **保证有**（至少一个；产物文本自带几个就保留几个） |
 * | `workspace-source`（工作区新建 `.kojo`，内核 io 缺省） | **有** | **LF** | 按文本（不补也不删） |
 * | `scaffold-text`（起手包 README + `.kojo` 空壳） | **无** | **LF** | **有**（骨架 `lines.join('\n') + '\n'`） |
 * | `scaffold-csv`（角色表 CSV，文本自带 BOM） | **有**（一次，writer 不再补） | **CRLF** | **有**（`\r\n`） |
 * | `export-file`（法定域外写） | 按字节（原样） | 按字节 | 按字节 |
 *
 * 产物那行的实证（本机全语料 3,715 个 `.ERB`/`.ERH` 抽样 372：364 有 BOM、
 * 371 LF）与 `packages/plugin-api/src/sugar.ts` 的 `SugarCompileEncoding` 缺省
 * （`{bom:true, eol:'lf', trailingNewline:true}`）一致；`.kojo` 语言教程面
 * （`eratw-adapter/src/tutorial-content.ts` ⑥ 保存段）向作者承诺的正是这一行，
 * 守卫会把它与表对拍（教程先漂 ⇒ 红）。
 *
 * ## 为什么三条路"不完全一样"却不是缺陷（本批**不改行为**）
 *
 * - `.kojo` 源在两条入口的 BOM 态不同：**起手包空壳 BOM-less**（`scaffold-text`），
 *   **新建单文件 / 另存 BOM**（`workspace-source`）。`.kojo` 只活在编辑器与工作区，
 *   **引擎永远读不到它**；而两侧读者都容忍 BOM（`artifact.ts::decodeSource`、
 *   内核 `readText` 的编码探测都会剥）。同一目录里两种 BOM 态不会让任何一条
 *   读回链失败，故不为了"整齐"去给起手包加 BOM——那会当场改掉默认糖档金样
 *   （`eratw-adapter/tests/fixtures/default-sugar/` 逐字节钉死）。
 * - 产物与语料同构（BOM + LF）是刻意的；语料里 8/372 个无 BOM、1/372 个 CRLF
 *   是作者历史遗留，工具产出统一形态即可（引擎两者都认）。
 * - 起手包 CSV 的 BOM 在**文本里**而不是 writer 里，是为了不走 `writeText`
 *   （`writeText` 给新文件缺省补 BOM ⇒ 自带 BOM 的 CSV 会变双 BOM）。这条是
 *   `scaffold-writer.ts` 头注的硬纪律，守卫按"源形状 + 落盘字节"两条一起钉。
 *
 * 本模块**零依赖、零 IO、零游戏知识**：只陈述"期望字节"，不产生字节。
 * 唯一的执行性导出是 {@link encodeScaffoldText}——它让"起手包路径 = 原样编码、
 * 不补 BOM"这件事在写手上有一个可被守卫对拍的落点（行为与旧的
 * `new TextEncoder().encode(text)` 逐字节相同）。
 */

/** BOM 口径：`as-authored` = 文本里带就带、不带就不带（writer 不增不减） */
export type BomPolicy = 'always' | 'never' | 'as-authored';

/** 换行口径：`as-authored` = 按调用方给的字节（`exportFile` 的透传语义） */
export type EolPolicy = 'lf' | 'crlf' | 'as-authored';

/** 末尾换行口径：`guaranteed` = 保证以换行收尾；`as-authored` = 按文本 */
export type TrailingNewlinePolicy = 'guaranteed' | 'as-authored';

/** 写盘路径 id（闭集；新增一条路必须同时加一行策略与一条字节断言） */
export type WritePathId =
  | 'compiled-product'
  | 'workspace-source'
  | 'scaffold-text'
  | 'scaffold-csv'
  | 'export-file';

/** 单条路径的编码策略 */
export interface WritePathEncoding {
  /** 是否携带 UTF-8 BOM（`EF BB BF` / 前导 U+FEFF） */
  readonly bom: BomPolicy;
  /** 行分隔符 */
  readonly eol: EolPolicy;
  /** 末尾换行 */
  readonly trailingNewline: TrailingNewlinePolicy;
  /** 谁真正写下这些字节（改动前先看这里） */
  readonly writer: string;
  /** 一句话口径（与守卫 ① 组的断言一一对应） */
  readonly note: string;
}

/** 三条路的**期望字节**（唯一陈述处；守卫按本表对拍真实写手） */
export const WRITE_ENCODING_POLICY = {
  'compiled-product': {
    bom: 'always',
    eol: 'lf',
    trailingNewline: 'guaranteed',
    writer: 'packages/plugins/kojo-sugar/src/compile.ts::encodeErbBytes（compileToBytes / compileToFile / lift-apply 共用）',
    note: '产物是生成物、整份重写：先归一 CRLF/CR → LF，剥一次尾换行再按选项补一个，最后加 EF BB BF。正文为空（纯空白源）时只剩 3 字节 BOM。',
  },
  'workspace-source': {
    bom: 'always',
    eol: 'lf',
    trailingNewline: 'as-authored',
    writer: 'packages/kernel/src/io.ts::writeText（新文件缺省 utf-8-bom / lf）',
    note: '工作区新建 `.kojo`（`ui-sugar-editor` 的 writeInto）走 writeText 缺省；已存在文件按盘上编码 / 换行保真，不在本行口径内。',
  },
  'scaffold-text': {
    bom: 'never',
    eol: 'lf',
    trailingNewline: 'guaranteed',
    writer: 'packages/kojo-project-kit/src/scaffold-writer.ts::writeScaffoldFiles（经 encodeScaffoldText 逐字节写）',
    note: '起手包 README 与各面 `.kojo` 空壳的首字符是 `#` / `;`，骨架不含 U+FEFF ⇒ 落盘 BOM-less；末尾一个 LF。',
  },
  'scaffold-csv': {
    bom: 'as-authored',
    eol: 'crlf',
    trailingNewline: 'guaranteed',
    writer: 'packages/plugins/eraakumamaid-adapter/src/scaffold.ts::buildErakumamaidCharaCsv（文本自带）+ 同一个 writeScaffoldFiles', // audit-allow: 记录产出方是哪枚适配器（编码策略表的一列，非游戏知识）
    note: '游戏自带 CSV 全是 UTF-8-BOM + CRLF ⇒ 文本自己带一次前导 U+FEFF 与 `\\r\\n`；writer 不补不剥（走 writeText 就会补成双 BOM）。',
  },
  'export-file': {
    bom: 'as-authored',
    eol: 'as-authored',
    trailingNewline: 'as-authored',
    writer: 'packages/kernel/src/io.ts::exportFile → app/src/bridge/tauri-bridge.ts → src-tauri/src/lib.rs::export_file（std::fs::write 原样写）',
    note: '字节透明通道：base64 过 IPC，Rust 原样写盘。调用方给什么就是什么——ZIP 二进制；另存 `.kojo` 由调用方补 U+FEFF（与 workspace-source 同字节）；归档条目取出是原始字节。',
  },
} as const satisfies Readonly<Record<WritePathId, WritePathEncoding>>;

/**
 * 产物编码的**期望值**（与契约 `SugarCompileEncoding` 的缺省同值）。
 *
 * 只用于守卫对拍：真正的编码器只有一个（`encodeErbBytes`），本常量不参与编码。
 */
export const PRODUCT_ENCODING = {
  bom: true,
  eol: 'lf',
  trailingNewline: true,
} as const;

/**
 * 起手包文本的落盘编码（**行为 = `new TextEncoder().encode(text)`**，逐字节相同）。
 *
 * 单独成函数的目的不是"做点什么"，而是给"起手包路径不补 BOM"一个可被守卫
 * 对拍的写手落点：文本自带 BOM（角色表 CSV）就带一次，不带（README / 空壳）
 * 就一个都不加。**不许**换成 `io.writeText`——那会给新文件缺省补 BOM。
 */
export function encodeScaffoldText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
