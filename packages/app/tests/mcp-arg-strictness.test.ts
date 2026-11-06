/**
 * MCP 入参严格化批（B11）· 漂移护栏 + 逐面行为自证
 *
 * 这一份要钉死的是**「以后谁新登记一个带参面忘了严格化 ⇒ 直接红」**，不只是「这批改对了」。
 * 四条判据，每条都能独立红：
 *  1. **注册表逐面严格**：`@kojo/mcp-host` 三张契约表（＝注册表里宿主自带的全部面）每一枚
 *     带参面必须逐字 `additionalProperties === false`；名单由现场算，**不硬编枚数**，
 *     新面漏了严格化就在这里红（红名单直接印出是哪几枚）。
 *  2. **声明 ⊇ 取用**：`CONSUMED` 是「执行腿实际取用的入参名」的显式对照表（逐面读腿写出来，
 *     出处写在每条注释里）；走共用分页闸的面直接展开导出的 `PAGE_SIZE_ARG_ALIASES`
 *     （序列真源＝`pageSizeOf`），于是「腿能吃、面没声明」＝严格化会把合法旧用法挡掉，当场红；
 *     反方向「面声明了、腿根本不取用」由 `DECLARED_BUT_NOT_CONSUMED` 逐条点名挂账。
 *  3. **未知键 ⇒ 显式 INVALID_ARGS**：不是「未知参数」四字了事——文案必须点名未知键、
 *     带回本面合法清单，并把拼错的旧别名（`maxResult` / `corridor`）就近指回真实合法名。
 *  4. **逐面行为零回退**：旧别名照旧生效、新名 `limit` 照旧生效、零参调用与改前逐字同读数；
 *     B1 钉下的游标 `pattern` / 越界 / `changedDuringPaging` 与各面体积闸一个字没动。
 *
 * 全程假注入（fake kernel / invoke / searchInFiles），不起 GUI、不起 Tauri、不起 HTTP。
 */
import { describe, expect, it } from 'vitest';
import {
  KERNEL_IO_TOOL_SPECS,
  McpFailure,
  PAGE_CURSOR_SCHEMA_PROPS,
  PAGE_SIZE_ARG_ALIASES,
  SEMANTIC_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  createMcpCapabilityRegistry,
  validateAgainstSchema,
  type McpHostDeps,
  type McpSessionScope,
} from '@kojo/mcp-host';
import type { CommandEntry } from '../src/ui/commands';
import {
  createKernelIo,
  createRunSupplemental,
  type McpIoDeps,
  type McpKernelLike,
  type McpSearchResultLike,
} from '../src/mcp/real-sources-io';

/* ------------------------------- 0. 现场取注册表面 ------------------------------- */

/** 三张契约表＝宿主自带的全部面（`createMcpCapabilityRegistry({})` 的 listTools 与之一一对应）。 */
const HOST_SPECS = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
const specByName = new Map(HOST_SPECS.map((s) => [s.name, s]));

/** 特权面要第四张表逐枚精确名批准才走得到校验层 ⇒ 会话按名单全批。 */
const scope: McpSessionScope = {
  sessionId: 'b11-s',
  clientId: 'b11-c',
  tier: 'privileged',
  approvedRoots: ['D:\\proj'],
  approvedTools: HOST_SPECS.filter((s) => s.tier === 'privileged').map((s) => s.name),
};

function schemaOf(name: string): Record<string, unknown> {
  const spec = specByName.get(name);
  expect(spec, `${name} 必须在三张契约表里在册`).toBeDefined();
  return spec!.inputSchema as Record<string, unknown>;
}

function propsOf(name: string): Record<string, unknown> {
  const props = schemaOf(name)['properties'];
  expect(props, `${name} 的 inputSchema 必须声明 properties`).toBeTypeOf('object');
  return props as Record<string, unknown>;
}

/** 真零参面（既有纪律，见 docs/mcp/README.md §10.5）：白名单与现场形状双向对拍。 */
const NO_ARG_TOOLS = ['app.dataDir', 'editor.cursor', 'project.info'] as const;

/* ------------------------------- 1. 执行腿取用对照表 ------------------------------- */

/**
 * 「执行腿实际取用的入参名」＝面声明的**下限**（声明可以更多，不可以更少）。逐条出处＝腿代码：
 *  - `SHARED_TEXT` ＝腿把原 args 交给 `paginateText`：游标 + 裸 offset + 整条别名序列；
 *  - `SHARED_LIST` ＝腿把原 args 交给 `paginateByCursor`：游标 + 整条别名序列（**不读 offset**）；
 *  - `SHARED_WINDOW` ＝腿把原 args 交给 `pageParamsFor`（检索族先要窗口再取数）；
 *  - `LITERAL` ＝该面不走共用闸，腿里逐字 `args['…']` 取用，表里就是那几条。
 */
const SHARED_TEXT = [...PAGE_SIZE_ARG_ALIASES, 'cursor', 'offset'];
const SHARED_LIST = [...PAGE_SIZE_ARG_ALIASES, 'cursor'];
const SHARED_WINDOW = [...PAGE_SIZE_ARG_ALIASES, 'cursor', 'offset'];

const CONSUMED: Readonly<Record<string, readonly string[]>> = {
  /* ---- 语义 8 腿（real-sources.ts buildSemanticReaders）---- */
  'semantic.definitionAt': ['line', 'column'], // targetOf(ws, args.line, args.column)
  'semantic.referencesAt': ['line', 'column', 'includeDeclaration'], // args.includeDeclaration !== false（腿一直在读）
  'semantic.hoverAt': ['line', 'column'],
  'semantic.suggestAt': ['line', 'column'],
  'semantic.codeActionsAt': ['line', 'column'],
  'semantic.diagnostics': SHARED_LIST, // pagedMarkerReading(markers, args)
  'semantic.documentSymbols': SHARED_LIST, // paginateByCursor(flat.items, …, args)
  'semantic.tokens': ['lineFrom', 'lineTo'], // toPositiveInt(args.lineFrom / args.lineTo)
  // MCP-PERF-S4（LaneK，2026-11-07）：全项目函数清单（erb.parser byName 索引；直连索引服务，
  // 无编辑器依赖）——paginateByCursor 走共用闸 ⇒ 整条别名序列 + cursor（腿不读裸 offset）。
  // MCP-PERF-S8（LaneR，2026-11-07）：+ query（次序无关子串过滤 needle，腿真取用）。
  'semantic.projectSymbols': ['query', ...SHARED_LIST],

  /* ---- kernel IO 3 腿（real-sources-io.ts createKernelIo）---- */
  'project.info': [], // 真零参
  'fs.tree': ['maxDepth', ...SHARED_LIST], // clampInt(args.maxDepth) + paginateByCursor(args)
  // MCP-PERF-S8（LaneR，2026-11-07）：+ deadlineMs（软时限，腿真带进 search_text 请求）+
  // preview（full|none，投影层剥 preview 字段）；两者都走 `searchDeadlineMsOf` / `searchPreviewModeOf` 闸。
  'search.all': ['query', 'resumeBySlice', 'deadlineMs', 'preview', ...SHARED_WINDOW], // query + pageParamsFor(args) + B16 分片开关 + S8 软时限/紧凑载荷

  /* ---- 补齐 / 只读具名工具 ---- */
  'workspace.searchAll': ['query', 'scope', 'resumeBySlice', 'deadlineMs', 'preview', ...SHARED_WINDOW], // S8 同上两枚 additive 入参
  'problems.quickFix': ['actionId', 'line', 'column'], // quick-fix.ts 三条取用
  // 该面腿先把 maxResults clamp 一遍再注入共用闸 ⇒ 序列里排在 maxResults 之后的四个别名
  // 在这个面上**从不生效**：不生效就不声明，让它们落进「未知入参 ⇒ 显式拒收」。
  'problems.diagnostics': ['limit', 'length', 'maxChars', 'maxResults', 'cursor'],
  // B19 扫描补的事实（不是手改口径）：B7 的写域多根入参 `rootId` 真被这四枚腿读
  // （`real-sources-io.ts::resolveWriteRoot` 第 1200 行 `args['rootId']`，
  // 经 `requireWriteTarget(input, …)` 传到腿里），本表此前漏登 ⇒ 由漂移闸暴露、照实补上。
  'fileTree.create': ['relPath', 'kind', 'content', 'rootId'],
  'fileTree.update': ['relPath', 'content', 'rootId'],
  // MCP-PERF-S3 批：批量腿取 args.changes（批次级预检）+ args.rootId（resolveWriteRoot 一次）。
  'fileTree.applyChangeset': ['changes', 'rootId'],
  // MCP-PERF-S6 批：patch 级写腿取 relPath + hunks（批次级预检）+ rootId（resolveWriteRoot 一次）。
  'fileTree.patchLines': ['relPath', 'hunks', 'rootId'],
  'fileTree.remove': ['relPath', 'recursive', 'rootId'],
  'fileTree.rename': ['from', 'to', 'rootId'],
  'diff.compare': [], // 无执行腿 ⇒ 显式 NOT_WIRED，一个键都不取用
  'state.replay': [],
  'preview.document': [],
  'commands.list': SHARED_LIST, // paginateByCursor(all, keyOf, args)
  'document.active': SHARED_TEXT, // paginateText(text, args)
  'fs.readFile': ['relPath', ...SHARED_TEXT], // resolveWithinRoot(args.relPath) + paginateText(args)
  // MCP-PERF-S4（LaneK，2026-11-07）：行区间读——腿读 relPath（resolveWithinRoot）+ 可选 rootId
  // （resolveWriteRoot 三道拦截）+ startLine/endLine（1 基闭区间；不走共用分页闸 ⇒ 无游标别名）。
  'fs.readRange': ['relPath', 'rootId', 'startLine', 'endLine'],
  'fs.stat': ['relPath'],
  'io.listDir': ['relPath', ...SHARED_LIST], // relPath + paginateByCursor(args)
  'io.workspaceRoots': SHARED_LIST,
  'editor.info': ['section'], // 腿只读 section
  'editor.selfCheck': SHARED_LIST, // selfCheckFindings(kernel, args) → paginateByCursor
  'lang.foldingRanges': ['maxRanges'], // clampInt(args.maxRanges)
  'lang.highlightsAt': ['line', 'column'],
  'lang.signatureAt': ['line', 'column'],
  'lang.markers': SHARED_LIST, // pagedMarkerReading(markers, args)
  'lang.lensesAt': ['line', 'maxResults'],
  'lang.selectionRangesAt': ['line', 'column', 'maxChains'],
  'app.dataDir': [],
  'editor.cursor': [],
  'codec.encodeString': ['text', 'encoding'],
  'fs.pathExists': ['relPath'],
  'fs.statFiles': ['relPaths', 'maxResults'],
  // B2 出厂即严格的对照样本：批读腿把 {offset, limit} 交给 paginateText，
  // 共用别名字典**不在**这条路上 ⇒ 该面只收这四个名字。
  'fs.readMany': ['relPaths', 'offset', 'limit', 'cursor'],

  /* ---- 长任务三枚（real-sources-tasks.ts）---- */
  'tasks.start': ['kind', 'query', 'scope', 'maxResults', 'force'],
  'tasks.status': ['taskId'],
  'tasks.cancel': ['taskId'],

  /* ---- 编辑器写 / 光标五枚（editor-write-legs.ts，B3 出厂即严格）---- */
  'editor.setValue': ['paneId', 'text'],
  'editor.type': ['paneId', 'text'],
  'editor.setCursor': ['paneId', 'line', 'column'],
  'editor.setSelection': ['paneId', 'startLine', 'startColumn', 'endLine', 'endColumn'],
  'editor.revealLine': ['paneId', 'line', 'reveal'],

  /* ---- 打开文档一枚（editor-open-legs.ts，B10 落 dev 的新面，本批补登记）---- */
  'editor.openDocument': ['relPath', 'deadlineMs'], // requireRelPath(args) + deadlineOf(args)，腿只取这两个

  /* ---- 启动器族 27 枚（real-sources-launcher.ts）---- */
  'launcher_instance_list': SHARED_LIST,
  'launcher_instance_get': ['instanceId'],
  'launcher_instance_update': ['instanceId', 'name', 'notes', 'tags'],
  'launcher_instance_remove': ['instanceId', 'deleteFiles', 'keepBackups'],
  'launcher_instance_duplicate': ['instanceId', 'name'],
  'launcher_content_list': ['instanceId', ...SHARED_LIST],
  'launcher_content_diagnose': ['instanceId', ...SHARED_LIST],
  'launcher_content_apply': ['planId', 'resolutions'],
  'launcher_content_uninstall': ['instanceId', 'packId'],
  'launcher_content_set_enabled': ['instanceId', 'packId', 'enabled'],
  'launcher_content_set_order': ['instanceId', 'packIds'],
  'launcher_process_list': SHARED_LIST,
  'launcher_process_status': ['instanceId'],
  'launcher_task_list': SHARED_LIST,
  'launcher_task_cancel': ['taskId'],
  'launcher_save_list': ['instanceId', ...SHARED_LIST],
  'launcher_save_backups': ['instanceId', ...SHARED_LIST],
  'launcher_save_backup': ['instanceId', 'label', 'reason', 'entries'],
  'launcher_save_restore': ['instanceId', 'backupId', 'backupCurrent'],
  'launcher_save_delete_backup': ['instanceId', 'backupId'],
  'launcher_save_apply_import': ['planId', 'resolutions'],
  'launcher_log_sessions': ['instanceId', ...SHARED_LIST],
  'launcher_log_tail': ['instanceId', 'stream', 'maxBytes', ...SHARED_LIST],
  'launcher_log_read': ['sessionId', 'stream', 'maxBytes', ...SHARED_LIST],
  'launcher_project_hash': ['projectDir', 'artifactDir', 'entries', ...SHARED_LIST],
  'launcher_start': ['instanceId'],
  'launcher_stop': ['instanceId', 'force', 'timeoutMs'],
};

/**
 * 「面上在册、执行腿却不取用」的历史声明——**逐条点名挂账**而不是悄悄留着。
 * 这些都是 B11 之前就存在的声明，本批只做严格化、不替别的线改口径，所以声明原样不动；
 * 记在这里＝这笔账可见：哪天有人把该面的这条入参真接上了，从本表划掉即可；
 * 哪天有人删掉声明，下面的在册性断言会红，逼他回来看这条理由（而不是无声消失）。
 */
const DECLARED_BUT_NOT_CONSUMED: Readonly<Record<string, readonly string[]>> = {
  'io.listDir': ['maxDepth'], // list_dir 单目录列举，depth 位在腿上没接线（fs.tree 那枚才真的 clampInt(maxDepth)）
  'editor.info': ['maxResults'], // 投影字段数是定值，腿不读这个上限
  'lang.foldingRanges': ['lineFrom', 'lineTo'], // provider 通道吃整篇文档，窗口位在腿上没接线
};

/** 走共用页大小闸的分页面＝CONSUMED 里含 `maxLines` 的那些（`fs.readMany` 这类只喂 {offset,limit} 的面自然落选）。 */
const SHARED_GATE_FACES = Object.entries(CONSUMED)
  .filter(([, consumed]) => consumed.includes('maxLines'))
  .map(([name]) => name);

/** 表里登记的例外：这些面走共用闸，但序列里有一部分名字在该面不生效（严格化后显式拒收）。 */
const PAGE_SIZE_NOT_CONSUMED: Readonly<Record<string, readonly string[]>> = {
  'problems.diagnostics': ['maxEntries', 'maxRanges', 'maxEvents', 'maxLines'],
};

/* ------------------------------- 判据 1：逐面严格 ------------------------------- */

describe('B11 判据 1 · 注册表里每一枚带参面都 additionalProperties:false', () => {
  it('三张契约表逐面严格（名单现场算，新面漏了严格化直接红）', () => {
    const loose = HOST_SPECS.filter((s) => schemaOf(s.name)['additionalProperties'] !== false).map((s) => s.name);
    expect(loose, `这些面还没严格化：${loose.join(' / ')}`).toEqual([]);
    expect(HOST_SPECS.length).toBeGreaterThan(60); // 规模自证：这条闸不是拿空表跑出来的绿
  });

  it('注册表 listTools 的面与三张表同数，同样逐面严格（装配链没绕过闸）', () => {
    const registry = createMcpCapabilityRegistry({});
    const listed = registry.listTools(scope);
    expect(listed.length).toBe(HOST_SPECS.length);
    const loose = listed
      .filter((t) => (t.inputSchema as Record<string, unknown>)['additionalProperties'] !== false)
      .map((t) => t.name);
    expect(loose, `注册表里这些面不严格：${loose.join(' / ')}`).toEqual([]);
  });

  it('对照表与三张表双向对齐（新面不登记取用表 ⇒ 红；表里留残项 ⇒ 红）', () => {
    expect(Object.keys(CONSUMED).sort()).toEqual(HOST_SPECS.map((s) => s.name).sort());
    for (const name of Object.keys(DECLARED_BUT_NOT_CONSUMED)) {
      expect(specByName.has(name), `${name} 已不在册，例外表里是残项`).toBe(true);
    }
  });

  it('零参面沿用既有口径：properties:{} + additionalProperties:false，白名单不留残项', () => {
    for (const name of NO_ARG_TOOLS) {
      const schema = schemaOf(name);
      expect(schema['additionalProperties'], `${name} 必须拒绝一切入参`).toBe(false);
      expect(Object.keys(schema['properties'] as Record<string, unknown>), `${name} 不许被改成带参`).toEqual([]);
    }
    const actuallyNoArg = HOST_SPECS.filter((s) => Object.keys(propsOf(s.name)).length === 0)
      .map((s) => s.name)
      .sort();
    expect(actuallyNoArg).toEqual([...NO_ARG_TOOLS].sort());
  });
});

/* ------------------------------- 判据 2：声明 ⊇ 取用 ------------------------------- */

describe('B11 判据 2 · 面声明的 properties ⊇ 执行腿实际取用的入参名', () => {
  for (const [name, consumed] of Object.entries(CONSUMED)) {
    it(`${name}：腿取用的 ${consumed.length} 个入参名全部在册`, () => {
      const declared = Object.keys(propsOf(name));
      const missing = consumed.filter((key) => !declared.includes(key));
      expect(missing, `${name} 的腿会取用而未声明：${missing.join(' / ')}（严格化会把合法旧用法挡掉）`).toEqual([]);
    });
  }

  it('走共用页大小闸的每一枚面：整条 PAGE_SIZE_ARG_ALIASES 都在册（别名不许被严格化挤掉）', () => {
    expect(SHARED_GATE_FACES.length).toBeGreaterThanOrEqual(20);
    for (const name of SHARED_GATE_FACES) {
      const declared = Object.keys(propsOf(name));
      const omitted = PAGE_SIZE_NOT_CONSUMED[name] ?? [];
      const missing = PAGE_SIZE_ARG_ALIASES.filter((alias) => !omitted.includes(alias) && !declared.includes(alias));
      expect(missing, `${name} 少声明共用页大小别名：${missing.join(' / ')}`).toEqual([]);
    }
  });

  it('列举型分页面的腿不吃裸 offset ⇒ 面上不许挂着 offset 骗人（游标才是续页凭据）', () => {
    const listFaces = SHARED_GATE_FACES.filter((name) => !(CONSUMED[name] ?? []).includes('offset'));
    expect(listFaces.length).toBeGreaterThanOrEqual(15);
    for (const name of listFaces) {
      expect(Object.keys(propsOf(name)), `${name} 的腿不读 offset，properties 里不该出现它`).not.toContain('offset');
    }
  });

  it('「在册但腿不取用」的历史声明逐条点名，且确实只挂着那几条', () => {
    for (const [name, keys] of Object.entries(DECLARED_BUT_NOT_CONSUMED)) {
      const declared = Object.keys(propsOf(name));
      for (const key of keys) expect(declared, `${name} 的 ${key} 应从声明里消失（账没销）`).toContain(key);
      for (const key of keys) expect(CONSUMED[name], `${name} 的取用表混进了未取用的键 ${key}`).not.toContain(key);
    }
  });

  it('游标声明逐面同源：每枚分页面的 cursor 形状就是 B1 钉下的那一份（pattern 未被改写）', () => {
    const paged = HOST_SPECS.filter((s) => Object.keys(propsOf(s.name)).includes('cursor'));
    expect(paged.length).toBe(26); // 24 枚待做 + fs.readMany（B2 出厂即严格）+ semantic.projectSymbols（MCP-PERF-S4）
    for (const spec of paged) {
      expect(propsOf(spec.name)['cursor'], `${spec.name} 的 cursor 形状必须与契约面同源`).toEqual(
        PAGE_CURSOR_SCHEMA_PROPS['cursor'],
      );
      expect(propsOf(spec.name)['limit'], `${spec.name} 的 limit 形状必须与契约面同源`).toEqual(
        PAGE_CURSOR_SCHEMA_PROPS['limit'],
      );
    }
  });
});

/* ------------------------------- 判据 3：未知键显式拒收 ------------------------------- */

describe('B11 判据 3 · 未知入参 ⇒ INVALID_ARGS（点名未知键 + 合法清单 + 最接近的合法名）', () => {
  const echoDeps: McpHostDeps = {
    runSupplemental: (name, args) => ({ echo: name, args }),
    semantic: Object.fromEntries(
      ['definitionAt', 'referencesAt', 'diagnostics', 'hoverAt', 'suggestAt', 'documentSymbols', 'tokens', 'codeActionsAt'].map(
        (method) => [method, (args: Record<string, unknown>) => ({ echo: args })],
      ),
    ) as McpHostDeps['semantic'],
    kernelIo: {
      projectInfo: () => ({ echo: 'projectInfo' }),
      fileTree: () => ({ echo: 'fileTree' }),
      searchAll: () => ({ echo: 'searchAll' }),
    },
  };

  it('三张表每一枚面都真的把未知键挡在校验层（逐面跑，不抽样）', async () => {
    const registry = createMcpCapabilityRegistry(echoDeps);
    for (const spec of HOST_SPECS) {
      const declared = Object.keys(propsOf(spec.name));
      const err = await registry.callTool(spec.name, { zzzNotAParam: 1 }, scope).then(
        () => null,
        (e: unknown) => e as McpFailure,
      );
      expect(err, `${spec.name} 必须拒收未知入参（旧行为是照收并静默忽略）`).not.toBeNull();
      expect(err!.code, `${spec.name} 的拒绝必须走 INVALID_ARGS`).toBe('INVALID_ARGS');
      expect(err!.message, `${spec.name} 的文案要点名未知入参`).toContain("未知入参 'zzzNotAParam'");
      if (declared.length > 0) {
        expect(err!.message, `${spec.name} 的文案要带回本面合法清单`).toContain(declared[0] as string);
      } else {
        expect(err!.message, `${spec.name} 是零参面，文案要说清「一个入参都不收」`).toContain('一个入参都不收');
      }
    }
  });

  it('拼错的旧别名不止被拒，还被指回真实合法名（一次改对，不用猜第二轮）', async () => {
    const registry = createMcpCapabilityRegistry(echoDeps);
    const cases: readonly [string, Record<string, unknown>, string, string][] = [
      ['fs.readFile', { relPath: 'a.kojo', maxResult: 20 }, 'maxResult', 'maxResults'],
      ['commands.list', { maxEntry: 20 }, 'maxEntry', 'maxEntries'],
      ['io.workspaceRoots', { maxResults2: 20 }, 'maxResults2', 'maxResults'],
      ['fs.readFile', { relPath: 'a.kojo', corridor: 'abcd1234:1' }, 'corridor', 'cursor'],
      ['document.active', { lentgh: 10 }, 'lentgh', 'length'],
      ['editor.selfCheck', { maxResult: 5 }, 'maxResult', 'maxResults'],
    ];
    for (const [name, args, sent, suggested] of cases) {
      const err = await registry.callTool(name, args, scope).then(
        () => null,
        (e: unknown) => e as McpFailure,
      );
      expect(err, `${name} 必须拒收 ${sent}`).not.toBeNull();
      expect(err!.code).toBe('INVALID_ARGS');
      expect(err!.message).toContain(`未知入参 '${sent}'`);
      expect(err!.message, `${name} 要把 ${sent} 指回 ${suggested}`).toContain(`最接近的合法名：${suggested}`);
      expect(err!.message).toContain('本面只收这些入参：');
    }
  });

  it('指回的第二条腿只认值证据：名字够不着时，值被唯一一枚窄形状收得下才指（否则照旧沉默）', () => {
    // ① corridor 这一类：键名与任何合法名的归一化距离都够不着阈值，但值本身是游标形状 ⇒ 指回 cursor。
    const one = validateAgainstSchema(schemaOf('fs.readFile'), { relPath: 'a.kojo', pagingToken: 'abcd1234:1' });
    expect(one.valid).toBe(false);
    expect(one.errors.join(' ')).toContain("未知入参 'pagingToken'");
    expect(one.errors.join(' ')).toContain('最接近的合法名：cursor');
    // ② 值什么都不是（裸整数）⇒ 一条证据也没有，不许把 size / min 这类名字推到模型眼前。
    const none = validateAgainstSchema(schemaOf('fs.readFile'), { relPath: 'a.kojo', size: 10 });
    expect(none.valid).toBe(false);
    expect(none.errors.join(' ')).not.toContain('最接近的合法名');
    // ③ 值同时被两枚窄形状收得下 ⇒ 有歧义就不猜，只摊清单。
    const both = validateAgainstSchema(
      {
        type: 'object',
        properties: {
          upper: { type: 'string', pattern: '^[A-Z0-9-]+$' },
          dotted: { type: 'string', pattern: '^[A-Z0-9.-]+$' },
        },
        additionalProperties: false,
      },
      { weird: 'AB-12' },
    );
    expect(both.valid).toBe(false);
    expect(both.errors.join(' ')).toContain('本面只收这些入参：upper / dotted');
    expect(both.errors.join(' ')).not.toContain('最接近的合法名');
  });

  it('够不着的乱名字不瞎猜，只把合法清单摊开（不把不相干的名字推到模型眼前）', () => {
    const v = validateAgainstSchema(
      { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
      { totallyUnrelatedKeyword: 1 },
    );
    expect(v.valid).toBe(false);
    expect(v.errors.join(' ')).toContain('本面只收这些入参：limit');
    expect(v.errors.join(' ')).not.toContain('最接近的合法名');
  });

  it('面值不是逐字 false（缺省 / true / schema 对象）一律照旧放行——不认识的关键字不误拒', () => {
    expect(validateAgainstSchema({ type: 'object', properties: { a: { type: 'integer' } } }, { b: 1 }).valid).toBe(true);
    expect(
      validateAgainstSchema({ type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: true }, { b: 1 }).valid,
    ).toBe(true);
    expect(
      validateAgainstSchema(
        { type: 'object', properties: { a: { type: 'integer' } }, additionalProperties: { type: 'string' } },
        { b: 1 },
      ).valid,
    ).toBe(true);
    expect(validateAgainstSchema({}, { anything: 1 }).valid).toBe(true); // 「无约束不误拒」旧口径没动
  });

  it('嵌套 items 的严格形状同样生效（启动器裁决项 / 存档子集不是只有顶层被管）', async () => {
    const registry = createMcpCapabilityRegistry(echoDeps);
    const err = await registry
      .callTool('launcher_content_apply', { planId: 'p-1', resolutions: [{ rootId: 'r', path: 'a', action: 'skip', extra: 1 }] }, scope)
      .then(
        () => null,
        (e: unknown) => e as McpFailure,
      );
    expect(err).not.toBeNull();
    expect(err!.code).toBe('INVALID_ARGS');
    expect(err!.message).toContain('resolutions[0].extra');
  });

  it('违规项有界且如实报数（单次最多 12 条，少报了几条必须写在文案里）', async () => {
    const value: Record<string, unknown> = {};
    for (let i = 0; i < 30; i += 1) value[`unknownArg${i}`] = i;
    const v = validateAgainstSchema(
      { type: 'object', properties: { limit: { type: 'integer' } }, additionalProperties: false },
      value,
    );
    expect(v.errors).toHaveLength(12);
    expect(v.omittedErrors).toBe(18);
    const registry = createMcpCapabilityRegistry(echoDeps);
    const err = await registry.callTool('commands.list', value, scope).then(
      () => null,
      (e: unknown) => e as McpFailure,
    );
    expect(err!.message).toContain('另有 18 条违规项未逐条列出');
  });
});

/* ------------------------------- 判据 4：逐面行为零回退（真腿读数） ------------------------------- */

describe('B11 判据 4 · 旧别名照旧生效 / limit 照旧生效 / 零参调用与改前逐字同读数', () => {
  const ROOT = 'D:\\proj';

  function fakeKernel(walkDir?: McpKernelLike['io']['walkDir']): McpKernelLike {
    return {
      project: {
        current: () => ({
          rootDir: ROOT,
          adapterId: 'adapter-a',
          kojoPaths: [`${ROOT}\\k`],
          charaIndex: new Map([[1, { no: 1, name: 'a' }]]),
        }),
      },
      io: { walkDir: walkDir ?? (async () => [{ name: 'a.kojo', path: `${ROOT}\\a.kojo`, isDirectory: false }]) },
      plugins: { list: () => [] },
      services: { tryGet: <T = unknown>(_key: string): T | undefined => undefined },
      bus: { on: (_name: string, _cb: (payload: unknown) => void) => () => {} },
      slots: { query: () => [] },
    };
  }

  const searchResult = (count: number): McpSearchResultLike => ({
    files: [{ path: `${ROOT}\\x.kojo`, matches: Array.from({ length: count }, (_, i) => ({ line: i + 1, preview: `hit ${i}` })) }],
    totalMatches: count,
    truncated: false,
    filesScanned: 1,
    elapsedMs: 2,
    skipped: {},
  });

  function deps(over: Partial<McpIoDeps> = {}): McpIoDeps {
    return {
      getKernel: over.getKernel ?? (() => fakeKernel()),
      getCommands:
        over.getCommands ??
        (() => Array.from({ length: 900 }, (_, i) => ({ id: `c${i}`, title: `T${i}`, run: () => undefined })) as readonly CommandEntry[]),
      invoke: over.invoke ?? (async () => null),
      searchInFiles: over.searchInFiles ?? (async () => searchResult(300)),
    };
  }

  const text = '口上行\n'.repeat(20_000); // 140_000 字符：页大小必须在这一页的账里现形
  const readCall = createRunSupplemental(deps({ invoke: async (cmd: string) => (cmd === 'read_file_bytes' ? text : null) }));
  const listCall = createRunSupplemental(
    deps({
      invoke: async (cmd: string) =>
        cmd === 'list_dir'
          ? Array.from({ length: 1200 }, (_, i) => ({ name: `f${i}.erb`, path: `${ROOT}\\f${i}.erb`, isDirectory: false }))
          : null,
    }),
  );
  const searchCall = createRunSupplemental(deps());
  const cmdsCall = createRunSupplemental(deps());
  const kernelIo = createKernelIo(deps());

  it('fs.readFile：八个旧别名与 limit 逐字等价（共用闸没被严格化挤掉）', async () => {
    for (const alias of PAGE_SIZE_ARG_ALIASES) {
      const r = (await readCall('fs.readFile', { relPath: 'a.kojo', [alias]: 700 }, scope)) as Record<string, unknown>;
      expect(String(r['text']).length, `别名 ${alias} 改后必须仍然生效`).toBe(700);
      expect(r['limit']).toBe(700);
    }
  });

  it('io.listDir：别名逐个生效 + 零参调用＝改前默认页（500 条，一个没放宽）', async () => {
    const zero = (await listCall('io.listDir', { relPath: '' }, scope)) as Record<string, unknown>;
    expect(zero['limit']).toBe(500);
    expect((zero['entries'] as unknown[]).length).toBe(500);
    for (const alias of PAGE_SIZE_ARG_ALIASES) {
      const r = (await listCall('io.listDir', { relPath: '', [alias]: 33 }, scope)) as Record<string, unknown>;
      expect((r['entries'] as unknown[]).length, `别名 ${alias} 在 io.listDir 上必须仍生效`).toBe(33);
    }
  });

  it('commands.list：maxResults 别名照旧 + 上限 500 / 默认 200 未动 + total 是真数', async () => {
    const legacy = (await cmdsCall('commands.list', { maxResults: 40 }, scope)) as Record<string, unknown>;
    expect(legacy['limit']).toBe(40);
    expect((legacy['commands'] as unknown[]).length).toBe(40);
    const big = (await cmdsCall('commands.list', { limit: 5_000_000 }, scope)) as Record<string, unknown>;
    expect((big['commands'] as unknown[]).length).toBe(500);
    const zero = (await cmdsCall('commands.list', {}, scope)) as Record<string, unknown>;
    expect(zero['limit']).toBe(200);
    expect(zero['total']).toBe(900);
  });

  it('workspace.searchAll / search.all：maxResults 别名与裸 offset 都照旧取用', async () => {
    const legacy = (await searchCall('workspace.searchAll', { query: 'hit', maxResults: 25 }, scope)) as Record<string, unknown>;
    expect(legacy['limit']).toBe(25);
    expect((legacy['hits'] as unknown[]).length).toBe(25);
    const off = (await searchCall('workspace.searchAll', { query: 'hit', offset: 100, limit: 10 }, scope)) as Record<string, unknown>;
    expect(off['offset']).toBe(100);
    const kernel = (await kernelIo.searchAll!({ query: 'hit', maxResults: 25 }, scope)) as Record<string, unknown>;
    expect(kernel['limit']).toBe(25);
  });

  it('fs.tree：maxEntries 旧名与新名 limit 同尺，maxDepth 照旧取用', async () => {
    const legacy = (await kernelIo.fileTree!({ maxEntries: 1 }, scope)) as Record<string, unknown>;
    expect((legacy['entries'] as unknown[]).length).toBe(1);
    const fresh = (await kernelIo.fileTree!({ limit: 1 }, scope)) as Record<string, unknown>;
    expect(fresh['limit']).toBe(1);
    const depth = (await kernelIo.fileTree!({ maxDepth: 3 }, scope)) as Record<string, unknown>;
    expect(depth['maxDepth']).toBe(3);
  });

  it('游标形状闸逐字未动：合法游标仍收，脏游标仍 INVALID_ARGS（B1 钉的那份 pattern）', async () => {
    const pattern = String((PAGE_CURSOR_SCHEMA_PROPS['cursor'] as Record<string, unknown>)['pattern']);
    expect(new RegExp(pattern).test('abcd1234:12')).toBe(true);
    expect(propsOf('fs.readFile')['cursor']).toEqual(PAGE_CURSOR_SCHEMA_PROPS['cursor']);
    await expect(readCall('fs.readFile', { relPath: 'a.kojo', cursor: 'nope' }, scope)).rejects.toThrow(/cursor 形状不合法/);
  });

  it('翻页中途改了快照仍显式 changedDuringPaging（本批没把这条静默回去）', async () => {
    let current = text;
    const call = createRunSupplemental(deps({ invoke: async (cmd: string) => (cmd === 'read_file_bytes' ? current : null) }));
    const first = (await call('fs.readFile', { relPath: 'a.kojo', limit: 4096 }, scope)) as Record<string, unknown>;
    expect(first['changedDuringPaging']).toBeUndefined();
    current = `${text}X`;
    const second = (await call('fs.readFile', { relPath: 'a.kojo', limit: 4096, cursor: String(first['nextCursor']) }, scope)) as Record<string, unknown>;
    expect(second['changedDuringPaging']).toBe(true);
    expect(second['offset']).toBe(0);
  });

  it('problems.diagnostics 的四个「在册也不生效」别名：显式拒收，不再静默按默认页大小', () => {
    const declared = Object.keys(propsOf('problems.diagnostics'));
    const omitted = PAGE_SIZE_NOT_CONSUMED['problems.diagnostics'] ?? [];
    expect(omitted).toHaveLength(4); // 例外表就是那四条，不许拿空数组跑绿
    for (const alias of omitted) {
      expect(declared, `${alias} 在该面不生效，就不该继续挂着`).not.toContain(alias);
    }
    expect(declared).toEqual(expect.arrayContaining(['maxResults', 'limit', 'length', 'maxChars', 'cursor']));
  });

  it('未接线的面（diff.compare / state.replay / preview.document）仍显式 NOT_WIRED，本批没顺手放行', async () => {
    const call = createRunSupplemental(deps());
    for (const name of ['diff.compare', 'state.replay', 'preview.document']) {
      await expect(call(name, {}, scope)).rejects.toThrow(/未接线/);
    }
  });
});
