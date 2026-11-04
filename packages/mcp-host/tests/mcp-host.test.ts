/**
 * @kojo/mcp-host 能力面 registry 单测（冻结契约 v1）。
 *
 * 全部 deps 注入假实现，不碰内核/bridge/Monaco。覆盖：tools/list × 命令注册表对拍、
 * inputSchema 校验、越权拒绝、privileged 标注、resources/prompts 形状、结构化错误。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createMcpCapabilityRegistry,
  commandToTool,
  isDangerousTool,
  isMcpFailure,
  validateAgainstSchema,
  MCP_RESOURCE_SPECS,
  SEMANTIC_TOOL_SPECS,
  KERNEL_IO_TOOL_SPECS,
  SUPPLEMENTAL_TOOL_SPECS,
  MCP_PROMPT_SKELETON_SPECS,
  RESOURCE_TEXT_LIMIT,
  truncateResourceText,
  slimActiveDocument,
  slimCommandList,
  slimPluginStatus,
  slimValidationFailures,
  renderSkeleton,
  createSkeletonPrompts,
  collectPromptSlotFragments,
  type McpCommandSource,
  type McpPrompt,
  type McpPromptSlotFragment,
  type McpSessionScope,
} from '@kojo/mcp-host';

const readScope: McpSessionScope = { sessionId: 's', clientId: 'c', tier: 'read', approvedRoots: [], approvedTools: [] };
const editScope: McpSessionScope = { ...readScope, tier: 'edit' };
const privScope: McpSessionScope = { ...readScope, tier: 'privileged' };

/** 把结构化失败 JSON 化取出（McpFailure.toJSON → {code,message}）。 */
async function failureOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    if (isMcpFailure(err)) return JSON.parse(JSON.stringify(err)) as { code: string; message: string };
    throw err;
  }
  throw new Error('预期抛结构化失败，实际成功');
}

const cmd = (over: Partial<McpCommandSource> = {}): McpCommandSource => ({
  id: 'demo.run',
  title: '运行',
  run: (args) => ({ echo: args }),
  ...over,
});

describe('tools/list × 命令注册表对拍', () => {
  it('命令 → 工具：name=id、description=description??title、inputSchema=argsSchema、tier 缺省 edit', () => {
    const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
    const reg = createMcpCapabilityRegistry({ commands: [cmd({ description: '面向模型', argsSchema: schema })] });
    const tool = reg.listTools(editScope).find((t) => t.name === 'demo.run');
    expect(tool).toBeDefined();
    expect(tool!.description).toBe('面向模型');
    expect(tool!.inputSchema).toEqual(schema);
    expect(tool!.tier).toBe('edit');
    // 缺省 description ⇒ 回退 title
    expect(commandToTool(cmd({ description: undefined })).description).toBe('运行');
    // 缺省 argsSchema ⇒ 空 schema
    expect(commandToTool(cmd()).inputSchema).toEqual({});
  });

  it('三路工具来源齐全：命令 + 8 条语义读数 + 3 条 kernel IO + 补齐功能', () => {
    const reg = createMcpCapabilityRegistry({ commands: [cmd()] });
    const names = reg.listTools(editScope).map((t) => t.name);
    expect(names).toContain('demo.run');
    for (const s of SEMANTIC_TOOL_SPECS) expect(names).toContain(s.name);
    for (const s of KERNEL_IO_TOOL_SPECS) expect(names).toContain(s.name);
    for (const s of SUPPLEMENTAL_TOOL_SPECS.filter((x) => x.tier !== 'privileged')) expect(names).toContain(s.name);
  });

  it('只读能力默认全开：read 会话仍列得所有 read 工具', () => {
    const reg = createMcpCapabilityRegistry({});
    const names = reg.listTools(readScope).map((t) => t.name);
    expect(names).toContain('semantic.definitionAt');
    expect(names).toContain('project.info');
    expect(names).toContain('search.all');
    expect(names).not.toContain('demo.run'); // edit 工具（若登记）不进 read 会话
  });
});

describe('privileged 标注（危险工具默认不进 tools/list）', () => {
  const dangerous = ['launcher_start', 'market_install', 'open_url_external', 'export_file', 'remove_path', 'rename_path'];

  it('危险 id 全部命中判定并强制标 privileged', () => {
    for (const id of dangerous) expect(isDangerousTool(id)).toBe(true);
    expect(isDangerousTool('demo.safe')).toBe(false);
    expect(commandToTool(cmd({ id: 'launcher_start', tier: 'read' })).tier).toBe('privileged');
  });

  it('readScope 默认不列 6 枚危险命令；显式批准后可见且 tier=privileged', () => {
    const reg = createMcpCapabilityRegistry({ commands: dangerous.map((id) => cmd({ id })) });
    const listed = reg.listTools(readScope).map((t) => t.name);
    for (const id of dangerous) expect(listed).not.toContain(id);
    const approved = reg.listTools({ ...privScope, approvedTools: dangerous }).filter((t) => dangerous.includes(t.name));
    expect(approved).toHaveLength(dangerous.length);
    for (const t of approved) expect(t.tier).toBe('privileged');
  });

  it('补齐功能里文件树删/改标 privileged，且带 destructiveHint', () => {
    const reg = createMcpCapabilityRegistry({});
    const all = reg.listTools({ ...privScope, approvedTools: ['fileTree.remove', 'fileTree.rename'] });
    for (const n of ['fileTree.remove', 'fileTree.rename']) {
      const t = all.find((x) => x.name === n);
      expect(t?.tier).toBe('privileged');
      expect(t?.annotations?.destructiveHint).toBe(true);
    }
  });
});

describe('inputSchema 结构化校验与越权拒绝', () => {
  const schema = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] };
  const reg = createMcpCapabilityRegistry({ commands: [cmd({ argsSchema: schema })] });

  it('校验器：合法 / 缺必填 / 类型错 / enum 越界', () => {
    expect(validateAgainstSchema(schema, { n: 3 }).valid).toBe(true);
    expect(validateAgainstSchema(schema, {}).valid).toBe(false);
    expect(validateAgainstSchema(schema, { n: 'x' }).valid).toBe(false);
    expect(validateAgainstSchema({ enum: ['a', 'b'] }, 'a').valid).toBe(true);
    expect(validateAgainstSchema({ enum: ['a', 'b'] }, 'c').valid).toBe(false);
    expect(validateAgainstSchema({}, { anything: 1 }).valid).toBe(true); // 无约束不误拒
  });

  it('合法入参正常执行并回传结果', async () => {
    expect(await reg.callTool('demo.run', { n: 3 }, editScope)).toEqual({ echo: { n: 3 } });
  });

  it('缺必填 / 类型错 ⇒ INVALID_ARGS（结构化 {code,message}）', async () => {
    expect(await failureOf(reg.callTool('demo.run', {}, editScope))).toMatchObject({ code: 'INVALID_ARGS' });
    expect((await failureOf(reg.callTool('demo.run', { n: 'x' }, editScope))).message).toContain('demo.run');
  });

  it('未知工具 ⇒ UNKNOWN_TOOL；read 会话调 edit ⇒ PERMISSION_DENIED', async () => {
    expect(await failureOf(reg.callTool('nope', {}, editScope))).toMatchObject({ code: 'UNKNOWN_TOOL' });
    expect(await failureOf(reg.callTool('demo.run', { n: 1 }, readScope))).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('privileged 工具未批准 ⇒ PERMISSION_DENIED；批准后可执行', async () => {
    const r = createMcpCapabilityRegistry({ commands: [cmd({ id: 'launcher_start' })] });
    expect(await failureOf(r.callTool('launcher_start', {}, privScope))).toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await r.callTool('launcher_start', {}, { ...privScope, approvedTools: ['launcher_start'] })).toEqual({ echo: {} });
  });

  it('执行体抛错 ⇒ TOOL_EXECUTION_FAILED（失败可见，不静默）', async () => {
    const r = createMcpCapabilityRegistry({ commands: [cmd({ run: () => { throw new Error('boom'); } })] });
    const f = await failureOf(r.callTool('demo.run', {}, editScope));
    expect(f.code).toBe('TOOL_EXECUTION_FAILED');
    expect(f.message).toContain('boom');
  });

  it('未接线的语义腿调用 ⇒ NOT_WIRED（不伪装空读数）', async () => {
    const r = createMcpCapabilityRegistry({});
    expect(await failureOf(r.callTool('semantic.definitionAt', { line: 1, column: 1 }, readScope))).toMatchObject({ code: 'NOT_WIRED' });
  });

  it('注入假语义/kernel 腿后可调用', async () => {
    const r = createMcpCapabilityRegistry({
      semantic: { definitionAt: (a) => [{ line: a.line }] },
      kernelIo: { projectInfo: () => ({ rootDir: '/x' }) },
    });
    expect(await r.callTool('semantic.definitionAt', { line: 4, column: 1 }, readScope)).toEqual([{ line: 4 }]);
    expect(await r.callTool('project.info', {}, readScope)).toEqual({ rootDir: '/x' });
  });
});

describe('resources 形状（≥6 项，插件状态 inactive 可见）', () => {
  it('内置清单 ≥6，URI 含项目快照/文件树/诊断/失败规则/命令/插件/事件', () => {
    const reg = createMcpCapabilityRegistry({});
    expect(reg.listResources().length).toBeGreaterThanOrEqual(6);
    expect(reg.listResources().length).toBe(MCP_RESOURCE_SPECS.length);
    expect(MCP_RESOURCE_SPECS.map((s) => s.uri)).toContain('kojo://project/plugins');
    expect(MCP_RESOURCE_SPECS.map((s) => s.uri)).toContain('kojo://project/validation-failures');
  });

  it('readResource 返回 {contents:[{uri,text}]}，数据源缺席不静默', async () => {
    const reg = createMcpCapabilityRegistry({ readResourceData: (uri) => ({ uri, inactive: [], missing: [] }) });
    const out = (await reg.readResource('kojo://project/plugins', readScope)) as { contents: { uri: string; text: string }[] };
    expect(out.contents).toHaveLength(1);
    expect(out.contents[0]!.uri).toBe('kojo://project/plugins');
    expect(JSON.parse(out.contents[0]!.text)).toMatchObject({ inactive: [], missing: [] });
    expect(out.contents[0]!.text).toContain('inactive'); // inactive/missing 必须可见

    const empty = createMcpCapabilityRegistry({});
    expect(await failureOf(empty.readResource('kojo://project/plugins', readScope))).toMatchObject({ code: 'RESOURCE_UNAVAILABLE' });
    expect(await failureOf(empty.readResource('kojo://nope', readScope))).toMatchObject({ code: 'UNKNOWN_RESOURCE' });
  });

  it('deps.resources 可覆盖内置项 / 追加新项', () => {
    const reg = createMcpCapabilityRegistry({
      resources: [{ uri: 'kojo://project/snapshot', name: '覆盖', description: '', read: async () => ({ contents: [{ uri: 'kojo://project/snapshot', text: 'x' }] }) }],
    });
    expect(reg.listResources().find((r) => r.uri === 'kojo://project/snapshot')?.name).toBe('覆盖');
  });
});

describe('prompts 形状', () => {
  const prompt: McpPrompt = {
    name: 'review',
    description: '审阅',
    arguments: [{ name: 'topic', required: true }],
    render: async (a) => ({ messages: [{ role: 'user', content: { type: 'text', text: `审阅 ${String(a.topic)}` } }] }),
  };
  const reg = createMcpCapabilityRegistry({ prompts: [prompt] });

  it('listPrompts / getPrompt 返回契约形状', async () => {
    expect(reg.listPrompts()).toHaveLength(1);
    const out = (await reg.getPrompt('review', { topic: 'X' }, readScope)) as { messages: { role: string; content: { type: string; text: string } }[] };
    expect(out.messages[0]!.role).toBe('user');
    expect(out.messages[0]!.content.type).toBe('text');
    expect(out.messages[0]!.content.text).toContain('X');
  });

  it('缺必填参数 / 未知提示 ⇒ 结构化失败', async () => {
    expect(await failureOf(reg.getPrompt('review', {}, readScope))).toMatchObject({ code: 'MISSING_PROMPT_ARGUMENT' });
    expect(await failureOf(reg.getPrompt('nope', {}, readScope))).toMatchObject({ code: 'UNKNOWN_PROMPT' });
  });
});

/* ============ 第二波：能力覆盖补齐 / resources 截断 / prompts 槽骨架 ============ */

describe('P1-9 能力覆盖补齐（工具清单 + 面向模型 description + 严格 schema）', () => {
  const names = SUPPLEMENTAL_TOOL_SPECS.map((s) => s.name);
  const EXPECTED = [
    'workspace.searchAll', // 全工程检索
    'problems.quickFix', // 问题面板 quickfix
    'problems.diagnostics', // 问题面板诊断
    'fileTree.create', // 文件树增
    'fileTree.update', // 文件树改
    'fileTree.remove', // 文件树删
    'fileTree.rename', // 文件树改名
    'diff.compare', // diff 视图
    'state.replay', // 状态回放
    'preview.document', // 2.0 预览
  ];

  it('六类补齐功能逐项在清单（10 枚工具、无重名）', () => {
    for (const n of EXPECTED) expect(names).toContain(n);
    expect(new Set(names).size).toBe(names.length);
  });

  it('每个工具有面向模型 description（非中文短标题）+ 严格 inputSchema', () => {
    for (const s of SUPPLEMENTAL_TOOL_SPECS) {
      expect(s.description.length).toBeGreaterThanOrEqual(60);
      expect(s.inputSchema['type']).toBe('object');
      const props = s.inputSchema['properties'];
      const declared = props !== null && typeof props === 'object' && Object.keys(props as object).length > 0;
      const required = Array.isArray(s.inputSchema['required']) && (s.inputSchema['required'] as unknown[]).length > 0;
      expect(declared || required).toBe(true); // 不是空 {type:'object'} 兜底
    }
  });

  it('只读项全带 readOnlyHint；危险项 privileged + destructiveHint', () => {
    for (const s of SUPPLEMENTAL_TOOL_SPECS) {
      if (s.tier === 'read') expect(s.annotations?.readOnlyHint).toBe(true);
    }
    for (const n of ['fileTree.remove', 'fileTree.rename']) {
      const s = SUPPLEMENTAL_TOOL_SPECS.find((x) => x.name === n)!;
      expect(s.tier).toBe('privileged');
      expect(s.annotations?.destructiveHint).toBe(true);
    }
  });

  it('补齐项在 tools/list：edit 会话列非 privileged 项，privileged 需逐项批准', () => {
    const reg = createMcpCapabilityRegistry({});
    const editNames = reg.listTools(editScope).map((t) => t.name);
    for (const n of EXPECTED.filter((n) => !['fileTree.remove', 'fileTree.rename'].includes(n))) {
      expect(editNames).toContain(n);
    }
    const readNames = reg.listTools(readScope).map((t) => t.name);
    expect(readNames).not.toContain('fileTree.remove');
    expect(readNames).not.toContain('fileTree.rename');
    const approved = reg.listTools({ ...privScope, approvedTools: ['fileTree.remove', 'fileTree.rename'] }).map((t) => t.name);
    for (const n of ['fileTree.remove', 'fileTree.rename']) expect(approved).toContain(n);
  });
});

describe('严格 inputSchema：相对路径约束（不给 MCP 任意目标路径）', () => {
  const relSchema = (
    SUPPLEMENTAL_TOOL_SPECS.find((s) => s.name === 'fileTree.create')!.inputSchema['properties'] as Record<string, unknown>
  )['relPath'] as Record<string, unknown>;

  it('pattern 生效：域内相对路径通过，绝对路径 / 盘符 / .. 逃逸被拒', () => {
    expect(validateAgainstSchema(relSchema, 'src/a.txt').valid).toBe(true);
    expect(validateAgainstSchema(relSchema, '/etc/passwd').valid).toBe(false);
    expect(validateAgainstSchema(relSchema, 'C:/x').valid).toBe(false);
    expect(validateAgainstSchema(relSchema, '../x').valid).toBe(false);
    expect(validateAgainstSchema(relSchema, 'a/../b').valid).toBe(false);
    expect(validateAgainstSchema(relSchema, '').valid).toBe(false); // minLength
  });

  it('callTool 对域外路径 / 缺必填入参 ⇒ INVALID_ARGS（结构化，不静默）', async () => {
    const reg = createMcpCapabilityRegistry({ runSupplemental: (name, args) => ({ name, args }) });
    expect(await failureOf(reg.callTool('fileTree.create', { relPath: '../evil', kind: 'file' }, editScope))).toMatchObject({ code: 'INVALID_ARGS' });
    expect(await failureOf(reg.callTool('workspace.searchAll', {}, editScope))).toMatchObject({ code: 'INVALID_ARGS' });
    expect(await reg.callTool('workspace.searchAll', { query: 'x' }, editScope)).toMatchObject({ name: 'workspace.searchAll' });
  });

  it('新校验器：pattern / minLength / maxLength 真正生效', () => {
    expect(validateAgainstSchema({ type: 'string', pattern: '^a+$' }, 'aaa').valid).toBe(true);
    expect(validateAgainstSchema({ type: 'string', pattern: '^a+$' }, 'aab').valid).toBe(false);
    expect(validateAgainstSchema({ type: 'string', minLength: 3 }, 'ab').valid).toBe(false);
    expect(validateAgainstSchema({ type: 'string', maxLength: 2 }, 'abc').valid).toBe(false);
  });
});

describe('resources：当前文档+光标 / 命令清单 / 插件 inactive+missing[] / failedRules 的截断标记', () => {
  it('内置清单新增 active-document，且仍 ≥6', () => {
    expect(MCP_RESOURCE_SPECS.map((s) => s.uri)).toContain('kojo://project/active-document');
    expect(MCP_RESOURCE_SPECS.length).toBeGreaterThanOrEqual(6);
    expect(RESOURCE_TEXT_LIMIT).toBeGreaterThan(0);
  });

  it('truncateResourceText：超上限显式 truncated:true + preview + hint；未超原样', () => {
    const long = truncateResourceText('x'.repeat(100), 10);
    expect(long.truncated).toBe(true);
    const env = JSON.parse(long.text) as { truncated: boolean; cap: number; preview: string; hint: string };
    expect(env.truncated).toBe(true);
    expect(env.cap).toBe(10);
    expect(env.preview).toHaveLength(10);
    expect(env.hint.length).toBeGreaterThan(0);
    expect(truncateResourceText('abc', 10)).toEqual({ text: 'abc', truncated: false });
  });

  it('投影函数：正文 / 列表 / 插件 / failedRules 都带 truncated 标记与可读性', () => {
    const doc = slimActiveDocument({ path: 'a.kojo', text: 'x'.repeat(9000), cursor: { line: 3, column: 2 } });
    expect(doc['truncated']).toBe(true);
    expect(doc['textLength']).toBe(9000);
    expect((doc['text'] as string).length).toBeLessThan(9000);
    expect((doc['cursor'] as { line: number }).line).toBe(3);

    const cmds = slimCommandList(Array.from({ length: 300 }, (_, i) => ({ id: `c${i}`, title: `T${i}` })));
    expect(cmds['truncated']).toBe(true);
    expect((cmds['commands'] as unknown[]).length).toBeLessThan(300);

    const plugins = slimPluginStatus({ active: [], inactive: [{ id: 'p', missing: ['dep'] }], missing: [] });
    expect(plugins['truncated']).toBe(false);
    const inactive = plugins['inactive'] as { missing: string[] }[];
    expect(inactive[0]!.missing).toEqual(['dep']); // inactive 项含 missing[]
    expect(plugins['missing'] as unknown[]).toEqual([]);
    expect(slimPluginStatus({})['warnings']).toBeDefined(); // 缺字段 ⇒ fail loud

    const vf = slimValidationFailures({ report: { failedRules: [{ rule: 'r1', message: 'm' }] } });
    expect((vf['failedRules'] as { rule: string }[])[0]!.rule).toBe('r1');
    expect(slimValidationFailures({})['warnings']).toBeDefined(); // report.failedRules 缺席不静默
  });

  it('registry.readResource 走投影 + 总闸：超长数据输出显式 truncated 标记', async () => {
    const reg = createMcpCapabilityRegistry({ readResourceData: () => ({ blob: 'z'.repeat(RESOURCE_TEXT_LIMIT + 500) }) });
    const out = (await reg.readResource('kojo://project/snapshot', readScope)) as { contents: { text: string }[] };
    expect((JSON.parse(out.contents[0]!.text) as { truncated: boolean }).truncated).toBe(true);
  });

  it('active-document 走正文投影：超长正文标 truncated 且保留光标', async () => {
    const reg = createMcpCapabilityRegistry({ readResourceData: () => ({ path: 'a.kojo', text: 'y'.repeat(RESOURCE_TEXT_LIMIT + 500), cursor: { line: 2, column: 4 } }) });
    const out = (await reg.readResource('kojo://project/active-document', readScope)) as { contents: { text: string }[] };
    const parsed = JSON.parse(out.contents[0]!.text) as { truncated: boolean; cursor: { line: number } };
    expect(parsed.truncated).toBe(true);
    expect(parsed.cursor.line).toBe(2);
  });
});

describe('prompts：零游戏名词骨架 + mcp.prompt 槽消费（不编造领域知识）', () => {
  it('≥2 个领域工作流骨架，模板只认通用 domain_* 槽、不含硬编码领域事实', () => {
    expect(MCP_PROMPT_SKELETON_SPECS.length).toBeGreaterThanOrEqual(2);
    for (const s of MCP_PROMPT_SKELETON_SPECS) {
      expect(s.slots.length).toBeGreaterThan(0);
      for (const slot of s.slots) expect(slot.startsWith('domain_')).toBe(true);
      expect(s.template).toContain('{{slot:');
      expect(s.template.length).toBeGreaterThan(80);
    }
  });

  it('缺槽 ⇒ 显式「领域槽未注入」标记（fail loud）；参数槽正常替换', () => {
    const spec = MCP_PROMPT_SKELETON_SPECS[0]!;
    const out = renderSkeleton(spec, { focus: 'DIAG' }, []);
    expect(out.messages[0]!.content.text).toContain('DIAG');
    expect(out.messages[0]!.content.text).toContain('领域槽未注入');
    expect(out.messages[0]!.content.text).not.toContain('{{slot:');
  });

  it('collectPromptSlotFragments 把槽贡献 render 出的文本收集成片段', async () => {
    const frags = await collectPromptSlotFragments([
      { name: 'domain_context', render: () => ({ messages: [{ content: { text: '<<DOMAIN>>' } }] }) },
    ]);
    expect(frags[0]).toMatchObject({ name: 'domain_context', text: '<<DOMAIN>>' });
    const built = createSkeletonPrompts(frags);
    expect(built).toHaveLength(MCP_PROMPT_SKELETON_SPECS.length);
    const rendered = await built[0]!.render({ focus: 'X' }, readScope);
    expect(rendered.messages[0]!.content.text).toContain('<<DOMAIN>>');
  });

  it('registry：promptSlots 缺省时行为不变；显式提供（含空数组）才并入骨架', async () => {
    const p: McpPrompt = { name: 'custom', description: 'x', render: async () => ({ messages: [{ role: 'user', content: { type: 'text', text: 'c' } }] }) };
    expect(createMcpCapabilityRegistry({ prompts: [p] }).listPrompts()).toHaveLength(1);
    const reg = createMcpCapabilityRegistry({ promptSlots: [] });
    expect(reg.listPrompts().length).toBe(MCP_PROMPT_SKELETON_SPECS.length);
    const out = (await reg.getPrompt('workflow.triage-diagnostics', { focus: 'X' }, readScope)) as { messages: { content: { text: string } }[] };
    expect(out.messages[0]!.content.text).toContain('领域槽未注入'); // 空片段 ⇒ 不静默
  });

  it('注入片段后骨架消费该片段（游戏知识只走槽）', async () => {
    const fragments: McpPromptSlotFragment[] = [{ name: 'domain_context', text: '<<ADAPTER_KNOWLEDGE>>', source: 'x-adapter' }];
    const reg = createMcpCapabilityRegistry({ promptSlots: fragments });
    const out = (await reg.getPrompt('workflow.triage-diagnostics', { focus: 'X' }, readScope)) as { messages: { content: { text: string } }[] };
    expect(out.messages[0]!.content.text).toContain('<<ADAPTER_KNOWLEDGE>>');
    expect(out.messages[0]!.content.text).toContain('X');
  });
});

/* ============ 能力盘点对拍：与第一波逐字同形的源码结构锚 ============
 * 路 A 的 tools/mcp-inventory.mjs 若按源码结构锚解析，本文件保持同样的
 * 导出常量名 + {name,description,inputSchema,tier,annotations} 字段形态即可被识别。
 * 脚本本身未落地（路 A 未合并），本护栏只做静态自证，不改那个脚本。
 */
describe('能力盘点对拍：源码结构锚形态保持一致', () => {
  const src = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  it('三组 *_TOOL_SPECS 导出锚仍在，逐项字段同形', () => {
    for (const anchor of ['SEMANTIC_TOOL_SPECS', 'KERNEL_IO_TOOL_SPECS', 'SUPPLEMENTAL_TOOL_SPECS']) {
      expect(src).toContain(`export const ${anchor}`);
    }
    for (const group of [SEMANTIC_TOOL_SPECS, KERNEL_IO_TOOL_SPECS, SUPPLEMENTAL_TOOL_SPECS]) {
      for (const s of group) {
        expect(typeof s.name).toBe('string');
        expect(typeof s.description).toBe('string');
        expect(typeof s.inputSchema).toBe('object');
        expect(['read', 'edit', 'privileged']).toContain(s.tier);
      }
    }
  });

  it('MCP_RESOURCE_SPECS / MCP_PROMPT_SKELETON_SPECS 导出锚存在', () => {
    expect(src).toContain('export const MCP_RESOURCE_SPECS');
    expect(src).toContain('export const MCP_PROMPT_SKELETON_SPECS');
  });
});

/* ============ 第三波：能力面真正够用（12 枚有真源只读工具 + 覆盖登记） ============ */
describe('第三波：能力面真正够用（12 枚只读工具 + 覆盖登记）', () => {
  const src3 = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const NEW_READ_TOOLS = [
    'commands.list', 'document.active', 'fs.readFile', 'fs.stat',
    'io.listDir', 'io.workspaceRoots', 'editor.info', 'editor.selfCheck',
    'lang.foldingRanges', 'lang.highlightsAt', 'lang.signatureAt', 'lang.markers',
  ];

  it('12 枚只读工具全部登记、tier=read + readOnlyHint、description 面向模型', () => {
    const names = SUPPLEMENTAL_TOOL_SPECS.map((s) => s.name);
    for (const n of NEW_READ_TOOLS) expect(names).toContain(n);
    for (const n of NEW_READ_TOOLS) {
      const s = SUPPLEMENTAL_TOOL_SPECS.find((x) => x.name === n)!;
      expect(s.tier).toBe('read');
      expect(s.annotations?.readOnlyHint).toBe(true);
      expect(s.description.length).toBeGreaterThanOrEqual(60);
      expect(s.inputSchema['type']).toBe('object');
    }
  });

  it('read 会话列得 12 枚新工具；三组工具清单的 tier 分组齐全', () => {
    const reg = createMcpCapabilityRegistry({});
    const listed = reg.listTools(readScope).map((t) => t.name);
    for (const n of NEW_READ_TOOLS) expect(listed).toContain(n);
    const all = [...SEMANTIC_TOOL_SPECS, ...KERNEL_IO_TOOL_SPECS, ...SUPPLEMENTAL_TOOL_SPECS];
    const count = (t: string) => all.filter((s) => s.tier === t).length;
    expect(count('read')).toBeGreaterThan(0);
    expect(count('edit')).toBeGreaterThan(0);
    expect(count('privileged')).toBeGreaterThan(0);
  });

  it('新工具执行走 runSupplemental；未接线 ⇒ NOT_WIRED（不返回空串假实现）', async () => {
    const bare = createMcpCapabilityRegistry({});
    expect(await failureOf(bare.callTool('commands.list', {}, readScope))).toMatchObject({ code: 'NOT_WIRED' });
    expect(await failureOf(bare.callTool('fs.readFile', { relPath: 'a.txt' }, readScope))).toMatchObject({ code: 'NOT_WIRED' });
    const wired = createMcpCapabilityRegistry({ runSupplemental: (name, args) => ({ name, args }) });
    expect(await wired.callTool('io.listDir', { relPath: 'src' }, readScope)).toMatchObject({ name: 'io.listDir' });
  });

  it('覆盖登记锚存在：MCP_TOOL_GAP_MAP / MCP_DEFERRED_GAP_NOTES（含显式原因）', () => {
    expect(src3).toContain('export const MCP_TOOL_GAP_MAP');
    expect(src3).toContain('export const MCP_DEFERRED_GAP_NOTES');
    expect(src3).toContain('绝不挂空串假实现'); // 无真源缺口显式标注
  });

  it('危险工具仍 privileged、默认不进 tools/list（第三波未放宽）', () => {
    const reg = createMcpCapabilityRegistry({});
    const readNames = reg.listTools(readScope).map((t) => t.name);
    for (const n of ['fileTree.remove', 'fileTree.rename']) expect(readNames).not.toContain(n);
  });
});
