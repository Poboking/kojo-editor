/**
 * MCP 真源腿 · 结构化批读面 `fs.readMany`（B2 批，LaneT，2026-11-06）。
 *
 * 一句话判性：内核早就有批量读原语（`kernel.io.readTexts`，契约见 `@kojo/plugin-api`
 * io.ts 的 `readTexts`：与 `readText` 同一条编码探测 / BOM / EOL 归一化管线、**每批一次
 * IPC**、逐文件失败不抛整批 ⇒ 失败位 `null`、可命中会话文本缓存、返回数组与入参一一对应
 * 含重复路径），但 MCP 面一直没登记——于是每读 20 个 `.erb` 就要付 20 趟 HTTP +
 * 20 次 WebView 往返 + 20 次单文件 `read_file_bytes` IPC。本模块把那条批量腿登记成
 * **一枚具名只读工具**，并把「`read_files_raw` 不登记以免暴露任意目标路径参数」这笔缺口
 * 的既有理由逐条拆掉后才收口：
 * - **结构化**：输出是 `TextFile` 投影（正文 / 编码 / EOL / mtime），不是 `ipc::Response`
 *   裸二进制帧；二进制帧那条性能通道本身仍留在 deferred 账上（见回执）。
 * - **只收项目根内相对路径**：逐条走与 `fs.readFile` / `fs.statFiles` **同一个**
 *   `resolveWithinRoot`（路径闸 + resolve-后前缀复核，fail-closed）。绝对路径 / 盘符 /
 *   `..` 逃逸 ⇒ 整批显式 `INVALID_ARGS`，读原语绝不触达（绝不把域外路径送到壳层）。
 * - **硬上限**：单次 ≤64 条（＝内核读批常量 `READ_BATCH_SIZE` 的量级：一批一趟 IPC），
 *   超限**显式报错并说明怎么分批**，绝不静默截断数组。
 *
 * 不静默（铁律 4）落成的形状：
 * - 返回 `items[]` 与入参逐条一一对应（含重复路径），失败位是
 *   `{path, ok:false, error:{code,message}}`——**绝不把 null 折成空串、绝不跳过该条**；
 *   失败原因再经**一次**批量 `stat_files` 复核分诊成 `NOT_FOUND` / `READ_FAILED`
 *   （只在有失败位时才付这一趟；分诊本身拿不到读数时如实写「无从判定」，不冒充 NOT_FOUND）；
 * - 总账字段逐条可见：`requested / succeeded / failed / maxPathsPerCall / overLimit /
 *   truncated / hasMore / charsReturned / offset / limit / fingerprint / nextCursor`；
 * - 失败分类不可得、内核返回长度与入参不等（`accountMismatch`）都单独出声。
 *
 * 分页口径（B1 批刚落地的同一套，**不新增第二套游标格式**）：
 * - 每文件各自一页，窗口由 `paginateText(text, {offset, limit})` 给出，
 *   默认 / 上限沿用 `MCP_PAGE_TEXT_DEFAULT_CHARS` / `MCP_PAGE_TEXT_MAX_CHARS`
 *   （闸值一字未动；单页压在宿主不可信串闸 65536 之下，「逐页拼接 == 全文」才成立）；
 *   每条的 `nextCursor` 即该文件正文指纹的游标，**可直接喂给 `fs.readFile`** 续读同一文件；
 * - 批次级 `cursor` 用同一 `encodePageCursor`/`decodePageCursor`，指纹对象是**本批相对路径
 *   清单**：清单变了 ⇒ `changedDuringPaging:true` 并从 0 重来（绝不盲切旧偏移冒充连续）；
 *   裸 `offset` 沿用「调用方自定窗口、不做连续性保证」的既有口径（逐条指纹留给客户端自证）。
 *
 * 新鲜度（Wave4 余项③ 口径，不许沉默跳过）：每条都附 `fsFreshness`（成功与失败位都附），
 * 与 `fs.statFiles` 的逐项标注同族；本工具名同步进 `fs-freshness.ts` 的 annotatedTools 名单。
 *
 * 只读自证：本腿只调 `kernel.io.readTexts`（读侧不过写闸、不建索引、不写盘）与只读
 * `stat_files`；**零 invoke 写命令、零 io 写原语、零编辑器副作用**。
 *
 * ps10 纪律：与 `real-sources-io.ts` 同侧，只被动态 import 的 MCP 装载链拉起，不进开机图。
 * 依赖注入：路径闸 / 项目上下文 / 失效标注器由调用方（`real-sources-io.ts`）传入——
 * 本模块只 `import type` 那些形状，**不反向 import 运行时**（零循环依赖）。
 */
import {
  McpFailure,
  assertCursorShape,
  decodePageCursor,
  encodePageCursor,
  pageFingerprint,
  paginateText,
} from '@kojo/mcp-host';
import type { McpSessionScope } from '@kojo/mcp-host';
import type { McpInvokeLike, McpIoDeps, McpKernelLike } from './real-sources-io';

/**
 * `kernel.io.readTexts` 契约的**最窄结构投影**（真 `TextFile` 在 `@kojo/plugin-api`，
 * 这里只取本腿真要读的四个字段；`path` 不用返回体里的，一律以请求侧解析结果为准）。
 */
export interface BatchTextFile {
  readonly path: string;
  readonly text: string;
  readonly encoding: string;
  readonly eol: string;
  readonly mtimeMs: number | null;
}

/** 单次调用的相对路径硬上限（超限显式报错；＝内核读批量级，一批一趟批量 IPC）。 */
export const MCP_BATCH_READ_MAX_PATHS = 64;

/** 注入形状：内核 seam + 与单文件读**同源**的路径闸 / 上下文 / 失效标注器。 */
export interface BatchReadDeps {
  readonly getKernel: McpIoDeps['getKernel'];
  /** 只用于失败位的批量 `stat_files` 分诊（只读命令，McpIoDeps 同一个 invoke seam）。 */
  readonly invoke: McpInvokeLike;
  readonly requireProject: (kernel: McpKernelLike | null) => Record<string, unknown>;
  readonly resolveWithinRoot: (rootDir: string, relPath: string) => string;
  readonly toRelativePath: (abs: string, rootDir: string) => string;
  readonly fsFreshness: (
    abs: string,
    rel: string,
    scope: McpSessionScope | null | undefined,
  ) => Record<string, unknown>;
  /** 文本面单页闸（生产传 `MCP_PAGE_TEXT_DEFAULT_CHARS` / `MCP_PAGE_TEXT_MAX_CHARS`，闸值不放宽）。 */
  readonly pageChars: { readonly defaultChars: number; readonly maxChars: number };
}

/** 逐条分诊用的批量 stat（只读；失败分类拿不到时如实降级，不猜）。 */
async function classifyFailures(
  invoke: McpInvokeLike,
  absPaths: readonly string[],
): Promise<Array<boolean | null>> {
  if (absPaths.length === 0) return [];
  let raw: unknown = null;
  try {
    raw = await invoke('stat_files', { paths: [...absPaths] });
  } catch {
    // 分诊本身失败不抹掉读失败这件事：调用方按「无从判定」逐条标注。
    return absPaths.map(() => null);
  }
  if (!Array.isArray(raw)) return absPaths.map(() => null);
  return absPaths.map((_abs, i) => {
    const row = raw[i];
    if (!row || typeof row !== 'object') return null;
    const exists = (row as Record<string, unknown>)['exists'];
    if (typeof exists !== 'boolean') return null;
    return exists;
  });
}

export function createBatchReadLeg(deps: BatchReadDeps): (
  args: Record<string, unknown>,
  scope: McpSessionScope | null | undefined,
) => Promise<unknown> {
  return async (rawArgs, scope) => {
    const args = rawArgs ?? {};
    const kernel = deps.getKernel();
    if (!kernel) {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '内核未到场：批读数据源不可用（不静默、不空数组冒充）');
    }
    const readTexts = kernel.io.readTexts;
    if (typeof readTexts !== 'function') {
      throw new McpFailure(
        'NOT_WIRED',
        'fs.readMany 未接线：内核批量读原语 io.readTexts 不可用（测试假件 / 精简桥）。' +
          '单文件读仍走 fs.readFile（真源 read_file_bytes）——本腿不降级成逐文件读，' +
          '那样会把「省往返」这件事变成看不见的假读数。',
      );
    }
    const project = deps.requireProject(kernel);
    const rootDir = typeof project['rootDir'] === 'string' ? (project['rootDir'] as string) : '';
    if (rootDir === '') {
      throw new McpFailure('RESOURCE_UNAVAILABLE', '项目载荷缺 rootDir：批读无域基准根（不静默）');
    }

    /* ---------------- 入参闸（严格：新工具不留旧别名） ---------------- */
    const inPaths = args['relPaths'];
    if (!Array.isArray(inPaths) || inPaths.length === 0) {
      throw new McpFailure(
        'INVALID_ARGS',
        'fs.readMany 的 relPaths 须为非空数组（项目根内相对路径逐条给出；只读一个文件请直接用 fs.readFile，批量接口按批才划算）',
      );
    }
    if (inPaths.length > MCP_BATCH_READ_MAX_PATHS) {
      throw new McpFailure(
        'INVALID_ARGS',
        `fs.readMany 单次上限 ${MCP_BATCH_READ_MAX_PATHS} 条，本次给了 ${inPaths.length} 条：整批拒绝（绝不静默截断数组尾部）。` +
          `请每批 ≤${MCP_BATCH_READ_MAX_PATHS} 条分次调用——该上限与内核读批常量同尺（一批一趟批量 IPC，帧大小＝批大小×单文件均长），不是可谈的便利参数。`,
      );
    }
    const relIn: string[] = [];
    inPaths.forEach((p, i) => {
      if (typeof p !== 'string' || p === '') {
        throw new McpFailure(
          'INVALID_ARGS',
          `fs.readMany.relPaths 第 ${i} 项须为非空字符串（绝对路径 / 盘符 / ".." 逃逸一律拒绝，只收项目根内相对路径）`,
        );
      }
      relIn.push(p);
    });
    // 逐条过路径闸 + 域内解析：任一项越界 ⇒ 整批 INVALID_ARGS，读原语绝不触达（fail-closed）。
    const absPaths = relIn.map((rel) => deps.resolveWithinRoot(rootDir, rel));

    /* ---------------- 分页账（批次级游标锁「本批路径清单」，逐条窗口走 paginateText） ---------------- */
    assertCursorShape(args); // 游标给了但形状非法 ⇒ INVALID_ARGS（绝不静默退回第一页冒充连续）
    const batchFingerprint = pageFingerprint(relIn);
    const decoded = decodePageCursor(args['cursor']);
    let changedDuringPaging = false;
    let offset = 0;
    if (decoded) {
      if (decoded.fingerprint === batchFingerprint) {
        offset = Math.max(0, decoded.index);
      } else {
        changedDuringPaging = true;
        offset = 0;
      }
    } else {
      const raw = args['offset'];
      offset = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    }
    // 单页长度：与 fs.readFile 同一套闸（default/max 由调用方注入，本批一个没放宽）。
    // 走 paginateText 的同一条取值路径，避免在 MCP 侧出现第二套「页大小怎么夹」的判据。
    const pageSize = paginateText('', { limit: args['limit'] }, {
      defaultLimit: deps.pageChars.defaultChars,
      maxLimit: deps.pageChars.maxChars,
    }).limit;

    /* ---------------- 一次批量读（一趟批量 IPC；失败位 null，不整批抛） ---------------- */
    const files = (await readTexts(absPaths)) as readonly (BatchTextFile | null)[];
    if (!Array.isArray(files)) {
      throw new McpFailure(
        'TOOL_EXECUTION_FAILED',
        `io.readTexts 未返回数组（实得 ${typeof files}）：逐条账目无从核对（不静默、不猜长度）`,
      );
    }
    const accountMismatch =
      files.length === absPaths.length
        ? null
        : { requested: absPaths.length, returned: files.length };

    const items: Record<string, unknown>[] = [];
    const failedAbs: string[] = [];
    const failedAt: number[] = [];
    for (let i = 0; i < relIn.length; i++) {
      const abs = absPaths[i] as string;
      const rel = deps.toRelativePath(abs, rootDir);
      const slot = files[i];
      // 契约的失败位是 null；这里再兜一层「形状不像 TextFile」（假件 / 版本漂移）同样按失败位记账。
      const file: BatchTextFile | null =
        typeof slot === 'object' && slot !== null && typeof (slot as BatchTextFile).text === 'string'
          ? (slot as BatchTextFile)
          : null;
      if (file === null) {
        // 失败位显式占位（原因在下面的分诊里填）：绝不折成空串、绝不跳过该条。
        items.push({ path: rel, ok: false, error: null, fsFreshness: deps.fsFreshness(abs, rel, scope) });
        failedAbs.push(abs);
        failedAt.push(items.length - 1);
        continue;
      }
      const p = paginateText(file.text, { offset, limit: args['limit'] }, {
        defaultLimit: deps.pageChars.defaultChars,
        maxLimit: deps.pageChars.maxChars,
      });
      items.push({
        path: rel,
        ok: true,
        text: p.page,
        textLength: p.total,
        truncated: p.truncated,
        offset: p.offset,
        limit: p.limit,
        hasMore: p.hasMore,
        // 逐条游标＝该文件正文指纹 + 下一字符偏移，可直接原样喂给 fs.readFile 续读同一文件。
        nextCursor: p.nextCursor,
        fingerprint: p.fingerprint,
        encoding: file.encoding,
        eol: file.eol,
        mtimeMs: file.mtimeMs,
        fsFreshness: deps.fsFreshness(abs, rel, scope),
      });
    }

    /* ---------------- 失败位分诊：一次批量 stat（只在真有失败位时付这一趟） ---------------- */
    if (failedAt.length > 0) {
      const existsFlags = await classifyFailures(deps.invoke, failedAbs);
      failedAt.forEach((itemIndex, k) => {
        const rel = String((items[itemIndex] as Record<string, unknown>)['path']);
        const exists = existsFlags[k];
        const entry = items[itemIndex] as Record<string, unknown>;
        if (exists === false) {
          entry['error'] = {
            code: 'NOT_FOUND',
            message: `盘上不存在：${rel}（io.readTexts 该位为 null，stat_files 复核 exists:false；不编造正文）`,
          };
        } else if (exists === true) {
          entry['error'] = {
            code: 'READ_FAILED',
            message:
              `读盘失败：${rel}（路径存在但批量读未带回正文——目录 / 权限 / 壳层读错误一类，` +
              '与 fs.readFile 在该路径抛错的失败条件同尺；具体原因以内核 IO 日志为准）',
          };
        } else {
          entry['error'] = {
            code: 'READ_FAILED',
            message:
              `读盘失败：${rel}（io.readTexts 该位为 null，且 stat_files 未带回可核对的读数：` +
              '存在与否无从判定，如实标注为读失败，不冒充 NOT_FOUND）',
          };
        }
      });
    }

    /* ---------------- 总账 ---------------- */
    const succeeded = items.filter((it) => it['ok'] === true).length;
    const failed = items.length - succeeded;
    const anyHasMore = items.some((it) => it['hasMore'] === true);
    const anyTruncated = items.some((it) => it['truncated'] === true);
    let charsReturned = 0;
    for (const it of items) {
      if (typeof it['text'] === 'string') charsReturned += (it['text'] as string).length;
    }
    const nextOffset = offset + pageSize;
    return {
      requested: relIn.length,
      succeeded,
      failed,
      maxPathsPerCall: MCP_BATCH_READ_MAX_PATHS,
      overLimit: false, // 超限是整批 INVALID_ARGS（见上），走到这里必然没超
      offset,
      limit: pageSize,
      truncated: anyTruncated,
      hasMore: anyHasMore,
      nextCursor: anyHasMore ? encodePageCursor(batchFingerprint, nextOffset) : null,
      fingerprint: batchFingerprint,
      charsReturned,
      ...(changedDuringPaging
        ? {
            changedDuringPaging: true,
            note: '本批路径清单与上一页的游标指纹不一致：本次从 offset 0 重发，不可与旧页拼接（旧行为会静默错位）。',
          }
        : {}),
      ...(accountMismatch !== null
        ? {
            accountMismatch,
            missingReasonNote:
              '内核批量读返回的条数与入参不等：多出的位置一律按失败位记账（READ_FAILED，无从判定分诊），绝不静默少一条。',
          }
        : {}),
      via: 'kernel.io.readTexts（每批一趟批量 IPC；可命中会话文本缓存，命中判据＝mtime+size 自证；单文件请仍用 fs.readFile）',
      cursorNote:
        '批次级 nextCursor 锁的是「本批 relPaths 清单 + 字符偏移」，原样回传即续读同一批的下一页；' +
        '逐条 nextCursor 锁的是该文件正文指纹，可直接喂给 fs.readFile 续读那一个文件。',
      items,
    };
  };
}
