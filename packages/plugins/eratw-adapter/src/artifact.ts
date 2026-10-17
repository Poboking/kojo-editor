/**
 * 制品计划（2026-10-12 导出批；纯函数，零 IO，可单测）。
 *
 * ## 它解决的问题
 *
 * 作者工作区里的包以 `.kojo` 为源（用户反馈 1：新建项目默认 `.kojo`，糖与原生 ERB
 * 可混写），而**引擎只认 `.ERB`**。所以「导出」和「部署」都不能再把目录原样复制出去——
 * 原样复制的包放进游戏目录是**静默不生效**的，比报错更糟。
 *
 * 本模块把"工作区文件集 → 制品文件集"这一步做成一个纯函数，于是：
 * - 导出 ZIP 与部署落盘**共用同一份计划**，不会出现"导出的能跑、部署的不能跑"；
 * - 转译规则、冲突判定、fail-closed 全部可在不启动内核、不碰磁盘的情况下被单测钉住。
 *
 * ## 四条规矩
 *
 * 1. **`.kojo` → `.ERB`**，同目录同基名，规则来自 `resolveSugarTarget`（单一真源，
 *    与"保存 `.kojo` 时产物落在哪"完全同源，不在此另立一套命名）。
 * 2. **非 `.kojo` 一律字节级原样携带**（`.txt` 说明、`.md`、图片、作者手写的 `.ERB`）。
 *    口上库的既有编码经一次转码就可能毁半库——这里刻意不解码不重编码。
 * 3. **制品里绝不出现 `.kojo`**。游戏读不到它，留着只会让作者以为"已经装好了"。
 * 4. **fail-closed**：任何一个 `.kojo` 转译失败 → 整个计划抛错，**不产半成品包**。
 *    半成品包比没有包更危险：作者会以为发布成功了。
 *
 * ## 同名 `.ERB` 先认作派生产物（2026-10-18 反馈修复批）
 *
 * 编辑器保存 `.kojo` 时会在旁边生成同名 `.ERB`（与 `resolveSugarTarget` 同源），
 * 于是"保存过一次"的包目录里必然成对出现——把两者都当源，就得报一个永远无法发布的
 * "假冲突"。规则（同目录、与编译目标同基名的 `.ERB`）：
 *
 * - 与当前 `.kojo` 编译结果**逐字节一致** → 跳过（派生产物不进制品），记入 `ignoredDerived`；
 * - 仅 BOM / 换行（CRLF）差异、规范化文本一致 → 同样跳过，记录时标注编码差异；
 * - 文本不同（过期或被手改）→ **fail-closed 抛错**，绝不静默二选一；
 * - 不同目录 / 不同基名、或只有 `.ERB` 没有 `.kojo` → 正常原样携带（作者手写产物）；
 * - `.ERH` 不在派生规则内（`.kojo` 只生成 `.ERB`）。
 *
 * 判定**不依赖目录枚举顺序**（`.ERB` 可能先于 `.kojo` 出现）：先收集全部 `.kojo`
 * 的目标并编译，再按原始源顺序回填条目。真正落成同一个产物名的两个 `.kojo`
 * （如大小写不同）仍然按"命名冲突必须拒绝"处理。
 *
 * ## 跨文件函数名必须唯一（2026-10-16 T4）
 *
 * 上面那条只挡「落成同一个**文件**」；而 Emuera 的函数名是**全局**的（`CALL` 按名找，
 * 不看文件），两个不同目录的文件各自产出 `@X` 时引擎只取一处、另一处**静默失效**——
 * 作者拿到的是坏包却毫无提示。工作区 `.kojo` 的产物落在常驻可写根，不在 `ErbIndex`
 * 的 root（游戏目录口上 ERB）里，既有 `erb.duplicate-function` 覆盖不到，这条补的就是它。
 *
 * 判定对象是**制品**而非源：`.kojo` 扫内存里的 `transpile.erb`，原样携带的 `.ERB` / `.ERH`
 * 也扫（**只解码不改字节**——扫名字是只读行为，铁律 2 字节级原样照旧）。函数定义名口径
 * 与 `erb-parser` 同源：行首（允许前导空白）`@` 后到第一个 `(` / 空白 / `;` 之间；
 * `$标签` / `#声明` / `;注释` 都不算。同名**也算**形参不同（引擎按名匹配）。
 * 只报「**两个不同来源**撞名」；同一来源内部重复定义属单文件自己的事，别处管。
 *
 * **大小写口径 = 折叠（大小写不敏感）**，语料实证：本机语料自带引擎配置
 * `魔改版更新记录文档/emuera_典文件内带的emueraconfig.txt` 有
 * `関数・属性については大文字小文字を無視しない:NO`——该配置 ID 在
 * `lang/emuera.zhs.xml` 映射到 `UI.ConfigDialog.Compatibility.NoIgnoreCase`
 * 「函数以及参数的大小写敏感」，值为 NO 即**关**（= 函数名大小写不敏感）；同文件
 * `同名の非イベント関数が複数定義されたとき警告する:NO` 说明引擎对重复定义**默认不警告**。
 * 与全项目既有口径（`ErbFunction.normalizedName = name.toUpperCase()`）一致。
 */

import {
  compareContent,
  resolveSugarTarget,
  type FileIO,
  type SugarCompiledBytes,
} from '@kojo/plugin-api';

/** 工作区里的一个源文件（`relPath` 用 `/` 分隔，相对包目录） */
export interface ArtifactSource {
  relPath: string;
  bytes: Uint8Array;
}

/** 制品里的一个文件（`relPath` 已是最终名，`/` 分隔） */
export interface ArtifactEntry {
  relPath: string;
  bytes: Uint8Array;
  /**
   * 工作区侧的源相对路径（additive，2026-10-15 比对批）。
   * 原样携带时 = relPath；`.kojo` 转译路径指向那份 `.kojo`——
   * 「这行产物来自工作区哪个文件」由此反查，不用再发明第二套映射。
   */
  sourceRel: string;
  /**
   * 产物全文（仅 `.kojo` 转译路径给出，来自 `transpile.erb`；additive）。
   * 转译产物只活在内存里（盘上没有这份字节），diff 视图要显示它只能靠这里；
   * 原样携带的文件为 undefined——宿主按 `sourceRel` 直接读盘即可。
   */
  text?: string;
}

/** 被判定为派生产物而跳过一个同名 `.ERB` 的记录（additive，2026-10-18 反馈修复批） */
export interface IgnoredDerivedArtifact {
  /** 被跳过的 `.ERB` 相对路径（保留磁盘上的大小写，`/` 分隔） */
  relPath: string;
  /** 生成它的 `.kojo` 源相对路径 */
  sourceRel: string;
  /**
   * 仅在**字节并不完全相同**、靠规范化文本判等才跳过时出现。
   * `encoding` = 仅 BOM / 换行风格差异，规范化文本一致。
   */
  reason?: 'encoding';
}

/** 计划结果与统计（反馈文案要能说清"转译了几个、原样带了几个"） */
export interface ArtifactPlan {
  entries: ArtifactEntry[];
  /** 由 `.kojo` 转译而来的文件数 */
  transpiled: number;
  /** 字节级原样携带的文件数 */
  passthrough: number;
  /**
   * 判定为 `.kojo` 编译产物、因而不进制品的同名 `.ERB`（additive）。
   * 只有与当前编译结果逐字节一致（或仅 BOM / 换行差异）的才会出现在这里；
   * 内容对不上 = 过期 / 被手改，直接抛错，不会静默跳过。
   */
  ignoredDerived: readonly IgnoredDerivedArtifact[];
}

/** 把 `.kojo` 源文本编成产物字节 —— 由 `SugarTranspileService.compileToBytes` 提供 */
export type KojoCompiler = (source: string, label: string) => SugarCompiledBytes;

/** 相对路径归一：反斜杠 → 正斜杠，去掉首部斜杠（walkDir 各家形态不一） */
export function toRelPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '');
}

/** 是否 `.kojo` 源文件（大小写不敏感） */
export function isKojoSource(relPath: string): boolean {
  return /\.kojo$/i.test(relPath);
}

/** 文本解码（`.kojo` 源按 UTF-8 读；带 BOM 时剥掉，避免把 BOM 当正文喂给转译器） */
function decodeSource(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 引擎会编译的产物（`.ERB` / `.ERH`，大小写不敏感）——原样携带的也要扫函数名 */
function isErbArtifact(relPath: string): boolean {
  return /\.(erb|erh)$/i.test(relPath);
}

/**
 * 扫出一段产物文本里的全部函数定义名（口径见模块头「跨文件函数名必须唯一」）。
 *
 * 与 `erb-parser` 的 `@` 头终止符同源（`(` / 空白 / `;`），但不 import 它——插件之间
 * 禁交叉 import（审计 C）；这里是**只读扫名**，口径对齐即可。
 */
function scanFunctionNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith('@')) continue; // `;` 注释 / `#` 声明 / `$` 标签都被这行挡掉
    const body = trimmed.slice(1);
    let end = body.length;
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (c === '(' || c === ' ' || c === '\t' || c === ';') {
        end = i;
        break;
      }
    }
    const name = body.slice(0, end).trim();
    if (name.length > 0) names.push(name);
  }
  return names;
}

/**
 * 生成制品计划。
 *
 * 三步规划（不依赖目录枚举顺序）：
 * 1. 路径归一 + 逃逸检查，并收集全部 `.kojo` 的编译目标（大小写不敏感键）；
 * 2. 先编译全部 `.kojo`（fail-closed；`ERB` 先于 `kojo` 出现也不影响判定）；
 * 3. 按原始源顺序回填条目：`.kojo` 的 claim + 产物条目、命中的同名 `.ERB`
 *    判等后跳过（或过期抛错）、其余非 `.kojo` 正常 claim + 原样携带。
 *
 * @param sources 包目录下的全部源文件（相对路径 + 字节）
 * @param compile `.kojo` → 产物字节（注入，便于单测用替身驱动 fail-closed）
 * @throws Error 命名冲突 / 派生产物过期 / 函数名冲突 / 转译失败（消息为中文，直接呈现给作者）
 */
export function planArtifacts(
  sources: readonly ArtifactSource[],
  compile: KojoCompiler,
): ArtifactPlan {
  const entries: ArtifactEntry[] = [];
  const ignoredDerived: IgnoredDerivedArtifact[] = [];
  const taken = new Map<string, string>(); // 归一化名 → 来源路径（报冲突时指认另一方）
  const fnOwners = new Map<string, { rel: string; name: string }>(); // 折叠函数名 → 首个来源
  let transpiled = 0;
  let passthrough = 0;

  const claim = (relPath: string, from: string): void => {
    // 大小写不敏感去重：Windows 文件系统上 `事件.ERB` 与 `事件.erb` 本就是同一个文件
    const key = relPath.toLowerCase();
    const prev = taken.get(key);
    if (prev !== undefined) {
      throw new Error(`产物名冲突（大小写不敏感）：「${prev}」与「${from}」都会落成 ${relPath}，请改名后再导出。`);
    }
    taken.set(key, from);
  };

  // 函数名全局唯一：不同来源产出同名函数 → 引擎只取一处、另一处静默失效（fail-closed）
  const claimNames = (rel: string, text: string): void => {
    for (const name of scanFunctionNames(text)) {
      const key = name.toUpperCase(); // 折叠口径：语料实证引擎大小写不敏感（见模块头）
      const prev = fnOwners.get(key);
      if (prev === undefined) {
        fnOwners.set(key, { rel, name });
        continue;
      }
      if (prev.rel === rel) continue; // 同一来源内部重复 = 单文件自己的事，不在此报
      const shown =
        prev.name === name
          ? `@${name}`
          : `@${name}（「${prev.rel}」写作 @${prev.name}，二者仅大小写不同）`;
      throw new Error(
        `函数名冲突：「${prev.rel}」与「${rel}」都会产出函数 ${shown}` +
          `（Emuera 函数名是全局的，重复定义时引擎只取一处、另一处静默失效），请改名后再导出。`,
      );
    }
  };

  /* ---------- 阶段 1：路径归一 + 逃逸检查 + 收集 `.kojo` 目标 ---------- */

  const files: Array<{ rel: string; src: ArtifactSource }> = [];
  for (const src of sources) {
    const rel = toRelPath(src.relPath);
    if (rel.length === 0) continue;
    if (rel.split('/').includes('..')) {
      throw new Error(`路径逃逸包目录：${rel}`);
    }
    files.push({ rel, src });
  }

  /** 归一化目标（小写、`/` 分隔）→ `.kojo` 源。`.ERB` 命中这里 = 派生产物候选 */
  const targets = new Map<string, string>();
  for (const { rel } of files) {
    if (!isKojoSource(rel)) continue;
    const target = resolveSugarTarget(rel);
    if (target === null) throw new Error(`无法从「${rel}」推导产物文件名。`);
    // 同一目标被两个 `.kojo` 命中的真冲突留给阶段 3 的 claim 报（此处覆盖无妨）
    targets.set(toRelPath(target).toLowerCase(), rel);
  }

  /* ---------- 阶段 2：先编译全部 `.kojo`（顺序 = 源顺序；任一失败整包不产） ---------- */

  const compiled = new Map<string, SugarCompiledBytes>();
  for (const { rel, src } of files) {
    if (!isKojoSource(rel)) continue;
    let result: SugarCompiledBytes;
    try {
      result = compile(decodeSource(src.bytes), rel);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`「${rel}」转译失败，未生成制品：${reason}`);
    }
    compiled.set(rel, result);
  }

  /* ---------- 阶段 3：按原始源顺序回填（派生产物在此判等） ---------- */

  for (const { rel, src } of files) {
    if (!isKojoSource(rel)) {
      // 与某个 `.kojo` 编译目标同路径的文件 = 派生产物候选（不依赖枚举顺序）。
      // 目标表只含 `.kojo` 推导出的 `.ERB`，不需要另写扩展名正则（单一真源在 resolveSugarTarget）。
      const derivedFrom = targets.get(rel.toLowerCase());
      if (derivedFrom !== undefined) {
        const result = compiled.get(derivedFrom);
        if (result === undefined) throw new Error(`内部错误：找不到「${derivedFrom}」的编译结果。`);
        // 字节态与行态从同一次比对派生（BOM 已由 decodeSource 剥掉；行态折叠 CRLF）
        const equality = compareContent(
          { bytes: src.bytes, text: decodeSource(src.bytes) },
          { bytes: result.bytes, text: decodeSource(result.bytes) },
        );
        if (equality.bytesEqual === true) {
          ignoredDerived.push({ relPath: rel, sourceRel: derivedFrom });
          continue;
        }
        if (equality.linesEqual === true) {
          // 文本一致、只是编码差异（BOM / 换行）——仍是同一份派生产物，跳过并标注
          ignoredDerived.push({ relPath: rel, sourceRel: derivedFrom, reason: 'encoding' });
          continue;
        }
        // 内容对不上 = 过期或被手改：绝不静默二选一，给出两条可执行路径
        throw new Error(
          `「${rel}」是「${derivedFrom}」的编译产物，但内容与当前编译结果不一致（可能过期或被手改）。` +
            `请重新保存 ${derivedFrom} 刷新产物，或把 ${rel} 改名/移出包目录后再发布。`,
        );
      }

      claim(rel, rel);
      // 引擎会编译的产物（.ERB/.ERH）也要扫函数名；只解码，字节照旧原样进制品
      if (isErbArtifact(rel)) claimNames(rel, decodeSource(src.bytes));
      entries.push({ relPath: rel, bytes: src.bytes, sourceRel: rel });
      passthrough += 1;
      continue;
    }

    // 目标名由单一真源推导；非 .kojo 走到这里不可能，但仍兜一层不静默
    const target = resolveSugarTarget(rel);
    if (target === null) throw new Error(`无法从「${rel}」推导产物文件名。`);
    const relTarget = toRelPath(target);
    claim(relTarget, rel);
    const result = compiled.get(rel);
    if (result === undefined) throw new Error(`内部错误：找不到「${rel}」的编译结果。`);
    // 产物全文里扫函数名（`.kojo` 只活在内存，其函数名与别处的冲突同样要挡）
    claimNames(rel, result.transpile.erb);
    entries.push({ relPath: relTarget, bytes: result.bytes, sourceRel: rel, text: result.transpile.erb });
    transpiled += 1;
  }

  return { entries, transpiled, passthrough, ignoredDerived };
}

/**
 * 读取包目录下的全部源文件（本模块**唯一**碰磁盘的函数）。
 *
 * 走 `readBytes` 而不是 `readText`：非 `.kojo` 的文件要**原样字节**进制品，
 * 一旦按文本读就可能被重编码（口上库里既有 UTF-8 也有 Shift-JIS 的辅助文件）。
 */
export async function readPackageSources(io: FileIO, srcDir: string): Promise<ArtifactSource[]> {
  const entries = await io.walkDir(srcDir, { includeFiles: true });
  const sources: ArtifactSource[] = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const rel = e.path.slice(srcDir.length).replace(/^[\\/]+/, '');
    if (rel.length === 0) continue;
    sources.push({ relPath: toRelPath(rel), bytes: await io.readBytes(e.path) });
  }
  return sources;
}
