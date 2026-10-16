import { describe, expect, it } from 'vitest';
import type { InstalledPack, MarketService, WorkspaceImportInput, WorkspaceService } from '@kojo/plugin-api';
import {
  buildTemplateImportInput,
  listMarketTemplates,
  templateKey,
  templatePreviewLine,
  templateSourceChoices,
  type KojoTemplateEntry,
} from '../src/new-project-wizard';
import { readPackAuthorship } from '../src/attribution';
import { scaffoldDirName } from '../src/scaffold';

/**
 * 新建向导「模板来源」单测（KM-14，1015 市场线）。
 *
 * 测试环境是 node（vitest `environment: 'node'`，不装 DOM），React 组件渲不了，
 * 所以沿用本包既有口径：纯函数直测 + fake workspaces 捕获实收入参
 * （见 `new-project-wizard.test.ts` 的「create 实收」）。
 *
 * 判据围绕三条不能错的边界：
 * 1. 默认恒为内置骨架——没接市场 / 没装模板包时，向导与历史逐字一致；
 * 2. 选中模板后产物来自 `importDirectory` 的字节级复制（源 = 模板包 contentDir），
 *    不再生成内置脚手架；
 * 3. 署名（pack.json）读不到**不阻断**——读到了才写署名键。
 */

const TPL: KojoTemplateEntry = {
  id: 'demo.template',
  version: '2.0.0',
  name: '示范模板',
  sourceDir: '/appdata/market/packs/template-pack/demo.template/2.0.0/files',
};

const FORM = { workName: '东方口上合集', charaName: '灵梦', version: '1.0', charaNo: 1, scriptNo: 3 };

describe('templateSourceChoices（「模板来源」下拉选项）', () => {
  it('无模板包：内置骨架仍是首项且默认；追加一条灰字说明，而不是把功能藏起来', () => {
    const choices = templateSourceChoices([]);
    expect(choices).toHaveLength(2);
    expect(choices[0]!.value).toBe('');
    expect(choices[0]!.label).toContain('内置骨架');
    expect(choices[0]!.disabled).toBeUndefined();
    // 唯一可选项只有内置：灰字项必须 disabled，否则"选不中"就成了嘴上的话
    expect(choices.filter((c) => c.disabled !== true)).toHaveLength(1);
    expect(choices[1]!.disabled).toBe(true);
    expect(choices[1]!.label).toContain('尚未安装模板包');
  });

  it('有模板包：内置骨架恒定首位，条目 = 「名称 v版本」，值 = <id>@<version>', () => {
    const choices = templateSourceChoices([TPL]);
    expect(choices).toHaveLength(2);
    expect(choices[0]!.value).toBe('');
    expect(choices[1]).toEqual({ value: 'demo.template@2.0.0', label: '示范模板 v2.0.0' });
  });
});

describe('templateKey（下拉值 = 制品 meta 的 template 字段）', () => {
  it('下拉值与制品 meta 的 template 字段同源（templateKey 是唯一拼接口径）', () => {
    expect(templateKey({ id: 'demo.template', version: '2.0.0' })).toBe('demo.template@2.0.0');
    expect(templateSourceChoices([TPL])[1]!.value).toBe(templateKey(TPL));
  });
});

/**
 * 装配侧投影（`plugin.ts` 传给向导的 `listTemplates` 就是它）：已装市场包 → 模板条目。
 * 组件渲不出来，但"哪些包算模板、sourceDir 从哪来"这条规则在这里被直测。
 */
describe('listMarketTemplates（已装市场包 → 模板条目）', () => {
  const rec = (kind: InstalledPack['kind'], id: string, version: string, name: string): InstalledPack => ({
    kind,
    id,
    version,
    name,
    author: '某某',
    license: 'CC0-1.0',
    contentDigest: 'digest',
    installedAt: 1,
    files: [],
  });

  it('只认 template-pack：口上包 / 字典包不混进来；sourceDir = contentDir(kind,id,version) 的返回', async () => {
    const contentsCalled: string[] = [];
    const market = {
      installed: async () => [
        rec('kojo-pack', 'demo.kojo', '1.0.0', '口上包'),
        rec('template-pack', 'demo.template', '2.0.0', '示范模板'),
        rec('dict-pack', 'demo.dict', '1.0.0', '字典包'),
        rec('template-pack', 'other.template', '3.1.0', '另一个模板'),
      ],
      contentDir: async (kind: string, id: string, version: string) => {
        contentsCalled.push(`${kind}/${id}@${version}`);
        return `/appdata/market/packs/${kind}/${id}/${version}/files`;
      },
    } as unknown as MarketService;

    const out = await listMarketTemplates(market);
    expect(out).toEqual([
      {
        id: 'demo.template',
        version: '2.0.0',
        name: '示范模板',
        sourceDir: '/appdata/market/packs/template-pack/demo.template/2.0.0/files',
      },
      {
        id: 'other.template',
        version: '3.1.0',
        name: '另一个模板',
        sourceDir: '/appdata/market/packs/template-pack/other.template/3.1.0/files',
      },
    ]);
    // 非模板包连 contentDir 都不该被问（问了就等于承认它可能是模板）
    expect(contentsCalled).toEqual(['template-pack/demo.template@2.0.0', 'template-pack/other.template@3.1.0']);
  });

  it('市场缺席（null）⇒ 空数组，不抛', async () => {
    expect(await listMarketTemplates(null)).toEqual([]);
  });

  it('installed() 抛错：向上抛（由装配侧收口成 warn + 空表），不在这里静默吞掉', async () => {
    const broken = {
      installed: async () => {
        throw new Error('storage gone');
      },
    } as unknown as MarketService;
    await expect(listMarketTemplates(broken)).rejects.toThrow('storage gone');
  });
});

describe('templatePreviewLine（模板模式的落点预览）', () => {
  it('数出来了：说 N 个文件，并明说不再生成内置骨架', () => {
    const line = templatePreviewLine(TPL, 12);
    expect(line).toContain('将导入模板「示范模板 v2.0.0」');
    expect(line).toContain('12 个文件');
    expect(line).toContain('内容原样复制');
    expect(line).toContain('不再生成内置骨架');
  });

  it('没数出来 / 目录读不动：如实说"以导入结果为准"，绝不照搬内置骨架的"将生成 N 个文件"', () => {
    const line = templatePreviewLine(TPL, null);
    expect(line).toContain('以导入结果为准');
    expect(line).toContain('内容原样复制');
    // 关键不对称：这句是另一种产物的台词，照搬过来就是预览撒谎
    expect(line).not.toMatch(/将生成/);
  });
});

describe('buildTemplateImportInput（模板模式的落点入参）', () => {
  it('目录名与内置分支同一条规则（scaffoldDirName）；name / dirName 同值、sourceDir 原样', () => {
    const input = buildTemplateImportInput(TPL, FORM, null);
    expect(input.dirName).toBe(scaffoldDirName({ workName: FORM.workName, charaName: FORM.charaName, version: FORM.version }));
    expect(input.name).toBe(input.dirName);
    expect(input.sourceDir).toBe(TPL.sourceDir);
  });

  it('meta = 内置分支那三样 + 模板身份；无署名时**不写**模板署名键（不写占位）', () => {
    const input = buildTemplateImportInput(TPL, FORM, null);
    expect(input.meta).toEqual({
      charaNo: 1,
      charaName: '灵梦',
      scriptNo: 3,
      template: 'demo.template@2.0.0',
    });
  });

  it('pack.json 读到署名：author / license 一并带上（空字段不写键）', () => {
    const withSig = buildTemplateImportInput(TPL, FORM, { author: '模板作者', license: 'CC BY-NC', authorLine: 2 });
    expect(withSig.meta.templateAuthor).toBe('模板作者');
    expect(withSig.meta.templateLicense).toBe('CC BY-NC');
    const emptySig = buildTemplateImportInput(TPL, FORM, { author: '', license: '', authorLine: 1 });
    expect('templateAuthor' in emptySig.meta).toBe(false);
    expect('templateLicense' in emptySig.meta).toBe(false);
  });
});

/**
 * 模板模式落链（fake workspaces 捕获）：组件在选中模板时走的就是这里这两步——
 * 读 pack.json 署名（best-effort）→ `create` → `importDirectory(buildTemplateImportInput(...))`。
 * 与既有「create 实收」同一手法：不渲组件，用真实的 helper + fake 捕捉实收参数。
 */
describe('模板模式落链（fake workspaces 捕获实收）', () => {
  const makeWorkspaces = (sink: {
    created: Array<{ name: string; meta?: Record<string, unknown>; rootDir?: string }>;
    imported: Array<{ projectId: string; input: WorkspaceImportInput }>;
  }): WorkspaceService =>
    ({
      create: async (input: { name: string; meta?: Record<string, unknown>; rootDir?: string }) => {
        sink.created.push(input);
        return { id: 'p1', name: input.name, createdAt: 1, updatedAt: 1, artifacts: [], meta: {} };
      },
      createArtifact: async () => {
        throw new Error('模板模式不该再生成内置脚手架');
      },
      importDirectory: async (projectId: string, input: WorkspaceImportInput) => {
        sink.imported.push({ projectId, input });
        return { id: 'a1', name: input.name, dirName: input.dirName, meta: {}, createdAt: 1 };
      },
    }) as unknown as WorkspaceService;

  it('选中模板：走 importDirectory（sourceDir = 模板包 contentDir），不再走 createArtifact', async () => {
    const sink = {
      created: [] as Array<{ name: string; meta?: Record<string, unknown> }>,
      imported: [] as Array<{ projectId: string; input: WorkspaceImportInput }>,
    };
    const workspaces = makeWorkspaces(sink);
    const io = {
      readText: async (p: string) => {
        if (p === '/appdata/market/packs/template-pack/demo.template/2.0.0/pack.json') {
          return { text: JSON.stringify({ id: 'demo.template', author: '模板作者', license: 'CC BY-NC' }) };
        }
        throw new Error(`没有这个文件：${p}`);
      },
    };

    const pack = await readPackAuthorship({ io, contentDir: TPL.sourceDir });
    const wsProject = await workspaces.create({
      name: FORM.workName.trim(),
      meta: { author: '张三', version: FORM.version.trim() },
    });
    await workspaces.importDirectory(wsProject.id, buildTemplateImportInput(TPL, FORM, pack));

    expect(sink.created).toHaveLength(1);
    expect(sink.imported).toHaveLength(1);
    const { projectId, input } = sink.imported[0]!;
    expect(projectId).toBe('p1');
    expect(input.sourceDir).toBe(TPL.sourceDir);
    expect(input.dirName).toBe(scaffoldDirName({ workName: FORM.workName, charaName: FORM.charaName, version: FORM.version }));
    expect(input.name).toBe(input.dirName);
    const meta = input.meta!;
    expect(meta.template).toBe('demo.template@2.0.0');
    expect(meta.templateAuthor).toBe('模板作者');
    expect(meta.templateLicense).toBe('CC BY-NC');
    expect(meta.charaNo).toBe(1);
    expect(meta.charaName).toBe('灵梦');
    expect(meta.scriptNo).toBe(3);
  });

  it('pack.json 读不到 / 不合法：不阻断——署名键不出现，导入照常发起', async () => {
    const sink = {
      created: [] as Array<{ name: string; meta?: Record<string, unknown> }>,
      imported: [] as Array<{ projectId: string; input: WorkspaceImportInput }>,
    };
    const workspaces = makeWorkspaces(sink);
    const io = {
      readText: async () => {
        throw new Error('ENOENT');
      },
    };

    const pack = await readPackAuthorship({ io, contentDir: TPL.sourceDir });
    expect(pack).toBeNull();
    await workspaces.importDirectory('p1', buildTemplateImportInput(TPL, FORM, pack));

    const meta = sink.imported[0]!.input.meta!;
    expect(meta.template).toBe('demo.template@2.0.0');
    expect('templateAuthor' in meta).toBe(false);
    expect('templateLicense' in meta).toBe(false);

    // 另一条不合法路径：pack.json 是坏 JSON（不是"文件不存在"）
    const badJson = {
      readText: async () => ({ text: '{ not json' }),
    };
    expect(await readPackAuthorship({ io: badJson, contentDir: TPL.sourceDir })).toBeNull();
  });

  it('模板包读到但两字段都空：按"没读到"处理（回退，不落空署名）', async () => {
    const io = {
      readText: async () => ({ text: JSON.stringify({ id: 'demo.template', files: [] }) }),
    };
    expect(await readPackAuthorship({ io, contentDir: TPL.sourceDir })).toBeNull();
  });
});
