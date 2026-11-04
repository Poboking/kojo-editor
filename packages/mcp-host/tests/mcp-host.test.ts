/**
 * @kojo/mcp-host 能力面 registry 单测（冻结契约 v1）。
 *
 * 全部 deps 注入假实现，不碰内核/bridge/Monaco。覆盖：tools/list × 命令注册表对拍、
 * inputSchema 校验、越权拒绝、privileged 标注、resources/prompts 形状、结构化错误。
 */
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
  type McpCommandSource,
  type McpPrompt,
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
