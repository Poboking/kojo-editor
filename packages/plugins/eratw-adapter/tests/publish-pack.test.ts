import { describe, expect, it } from 'vitest';
import {
  PACK_ID_RE,
  PACK_VERSION_RE,
  type MarketPackDraftFile,
  type MarketService,
  type WorkspaceArtifact,
  type WorkspaceProject,
} from '@kojo/plugin-api';
import { LICENSE_CHOICES } from '@kojo/kojo-project-kit';
import {
  PACK_ID_PREFIX,
  buildPublishDraft,
  defaultPackId,
  draftDefaults,
  draftFilesOf,
  formatBytes,
  licenseHintOf,
  licenseLabelOf,
  licenseNameOf,
  licenseOptions,
  normalizeVersion,
  packIdProblem,
  progressLabel,
  progressPercent,
  publishCapabilityNote,
  publishCapabilityOf,
  readableLicenseKind,
  slugifyProjectId,
  versionProblem,
  zipBaseName,
  zipPublishDefaults,
} from '@kojo/kojo-project-kit';
import type { ArtifactEntry, ArtifactPlan } from '@kojo/kojo-project-kit';

/**
 * 「发布口上」纯函数半边（用户反馈 4 批）的判据。
 *
 * 组件在 node 里渲不出来（无 react-dom），所以**默认值提取 / id 与版本规则 /
 * 许可投影 / 制品计划映射 / 进度文案 / 能力三态**这些"会进包的事实"全部在这里钉住：
 * 任何一条漂了，作者看到的默认值或最终 `pack.json` 就会跟着变。
 */

/* ------------------------------ 测试素材 ------------------------------ */

function artifactOf(over: Partial<WorkspaceArtifact> = {}): WorkspaceArtifact {
  return {
    id: 'a-1',
    name: '春告げの庭-露米娅 v0.3',
    dirName: '春告げの庭-露米娅 v0.3',
    meta: {},
    createdAt: 1,
    ...over,
  };
}

function projectOf(over: Partial<WorkspaceProject> = {}): WorkspaceProject {
  return {
    id: 'p-mf9x2a-abc123',
    name: '东方口上合集',
    createdAt: 1,
    updatedAt: 1,
    artifacts: [artifactOf()],
    meta: {},
    ...over,
  };
}

function entryOf(relPath: string, text: string): ArtifactEntry {
  const bytes = new TextEncoder().encode(text);
  return { relPath, bytes, sourceRel: relPath };
}

/* ------------------------------ 版本补段 ------------------------------ */

describe('normalizeVersion · 作者写的版本补成市场要的三段', () => {
  it('1.0 → 1.0.0、1 → 1.0.0（新建向导的默认值就能直接用）', () => {
    expect(normalizeVersion('1.0')).toBe('1.0.0');
    expect(normalizeVersion('1')).toBe('1.0.0');
    expect(normalizeVersion(' 2.1 ')).toBe('2.1.0');
  });

  it('三段原样保留（不重排、不补零）', () => {
    expect(normalizeVersion('1.2.3')).toBe('1.2.3');
    expect(normalizeVersion('0.0.1')).toBe('0.0.1');
  });

  it('预发布后缀先剥掉（与安装面 coreVersion 同一条）', () => {
    expect(normalizeVersion('1.2.3-beta.1')).toBe('1.2.3');
    expect(normalizeVersion('0.4-beta')).toBe('0.4.0');
  });

  it('补不出来就返回空串——不替作者猜版本号（交给必填校验拦住）', () => {
    expect(normalizeVersion('')).toBe('');
    expect(normalizeVersion('beta')).toBe('');
    expect(normalizeVersion('1.2.x')).toBe('');
    expect(normalizeVersion('1.2.3.4')).toBe('');
    expect(normalizeVersion('v1.0')).toBe('');
  });
});

/* ------------------------------ 包 id ------------------------------ */

describe('slugifyProjectId / defaultPackId · 默认包 id 必须一开始就合法', () => {
  it('正常项目 id 原样进 slug（内核生成的 p<base36>-<rand> 天然合规）', () => {
    expect(slugifyProjectId('p-mf9x2a-abc123')).toBe('p-mf9x2a-abc123');
    expect(slugifyProjectId('P-MF9X2A-ABC123')).toBe('p-mf9x2a-abc123');
  });

  it('历史/手工 id 里的非法字符被消毒，首尾的多余分隔符去掉', () => {
    expect(slugifyProjectId('我的 项目#1')).toBe('1');
    expect(slugifyProjectId('__p.1__')).toBe('p.1');
    expect(slugifyProjectId('   ')).toBe('project');
    expect(slugifyProjectId('!!!')).toBe('project');
  });

  it('默认 id = kojo.<项目 id>.<包序号>，且总是一开始就过 PACK_ID_RE', () => {
    const first = defaultPackId('p-mf9x2a-abc123', 0);
    expect(first).toBe(`${PACK_ID_PREFIX}.p-mf9x2a-abc123.1`);
    expect(first).toMatch(PACK_ID_RE);
    const third = defaultPackId('p-mf9x2a-abc123', 2);
    expect(third.endsWith('.3')).toBe(true);
    expect(third).toMatch(PACK_ID_RE);
  });

  it('超长项目 id 截断后仍 ≤ 64 字符（否则平台容器名会先一步拒掉）', () => {
    const long = `p-${'x'.repeat(120)}`;
    const id = defaultPackId(long, 0);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(PACK_ID_RE);
  });

  it('负序号 / 非整数序号按 1 处理（默认值不能因为调用方笔误就非法）', () => {
    expect(defaultPackId('p1', -1).endsWith('.1')).toBe(true);
    expect(defaultPackId('p1', Number.NaN).endsWith('.1')).toBe(true);
  });
});

describe('packIdProblem / versionProblem · 与人话同源的实时校验', () => {
  it('合法输入返回 null（判据就是契约的那两个正则）', () => {
    expect(packIdProblem('kojo.p1.1')).toBeNull();
    expect(versionProblem('1.0.0')).toBeNull();
  });

  it('非法输入给出可读提示（不是把正则拍到作者脸上）', () => {
    expect(packIdProblem('')).toContain('不能为空');
    expect(packIdProblem('Kojo.P1')).toContain('小写字母');
    expect(packIdProblem('-kojo')).toContain('首字符');
    expect(versionProblem('')).toContain('不能为空');
    expect(versionProblem('1.0')).toContain('三段');
    expect(versionProblem('1.0.0-beta')).toContain('三段');
  });
});

/* ------------------------------ 默认字段提取 ------------------------------ */

describe('draftDefaults · 从项目 / 包元数据提取默认值', () => {
  it('名称 = 包名；id 按包序号；版本从包 meta 补三段；作者取项目 meta', () => {
    const project = projectOf({ meta: { author: '阿作者', version: '2.0' } });
    const artifact = artifactOf({ meta: { version: '1.3' } });
    const d = draftDefaults(project, artifact, 0);
    expect(d.name).toBe('春告げの庭-露米娅 v0.3');
    expect(d.id).toBe('kojo.p-mf9x2a-abc123.1');
    expect(d.version).toBe('1.3.0');
    expect(d.author).toBe('阿作者');
    expect(d.summary).toBe('');
    expect(d.licenseKind).toBe('none');
  });

  it('包 meta 没版本 → 项目 meta 的版本 → 都没有就 1.0.0', () => {
    expect(draftDefaults(projectOf({ meta: { version: '2.0' } }), artifactOf(), 0).version).toBe('2.0.0');
    expect(draftDefaults(projectOf(), artifactOf(), 0).version).toBe('1.0.0');
  });

  it('包 meta 写了但补不出三段 ⇒ 留空交给作者改，不拿项目版本冒充', () => {
    const project = projectOf({ meta: { version: '2.0' } });
    expect(draftDefaults(project, artifactOf({ meta: { version: 'beta' } }), 0).version).toBe('');
  });

  it('作者取不到就留空（必填由作者自己填，不拿原作者署名冒充发布者）', () => {
    expect(draftDefaults(projectOf(), artifactOf({ meta: { originalAuthor: '前人' } }), 0).author).toBe('');
    expect(draftDefaults(projectOf({ meta: { author: '   ' } }), artifactOf(), 0).author).toBe('');
  });

  it('包名空白时回落到目录名（默认值不能是空串）', () => {
    expect(draftDefaults(projectOf(), artifactOf({ name: '  ' }), 0).name).toBe('春告げの庭-露米娅 v0.3');
  });

  it('许可种类从包 meta 预选（导入包带着原作者的选择）；陌生取值 → none', () => {
    expect(draftDefaults(projectOf(), artifactOf({ meta: { licenseKind: 'mit' } }), 0).licenseKind).toBe('mit');
    expect(readableLicenseKind('not-a-license')).toBeNull();
    expect(draftDefaults(projectOf(), artifactOf({ meta: { licenseKind: 'not-a-license' } }), 0).licenseKind).toBe(
      'none',
    );
  });
});

describe('zipPublishDefaults · 普通作品包 zip 的默认值（ZIP-1）', () => {
  it('zip 文件名去掉 .zip；单层包裹目录优先当包名', () => {
    expect(zipBaseName('/tmp/蕾蒂CB風.zip')).toBe('蕾蒂CB風');
    expect(zipBaseName('C:\\tmp\\LETTY.ZIP')).toBe('LETTY');
    expect(zipBaseName('/tmp/.zip')).toBe('zip');
    const d = zipPublishDefaults(
      '/tmp/Letty CB.zip',
      { files: [], strippedRoot: 'キャノボ風レティ' },
      null,
    );
    expect(d.name).toBe('キャノボ風レティ');
  });

  it('id 由 zip 名消毒成合法值；纯日文名退化成 kojo.zip.1 但仍合法', () => {
    expect(zipPublishDefaults('/tmp/Letty CB.zip', { files: [] }, null).id).toBe(
      'kojo.zip-letty-cb.1',
    );
    expect(zipPublishDefaults('/tmp/キャノボ風レティ.zip', { files: [] }, null).id).toBe('kojo.zip.1');
  });

  it('版本固定 1.0.0（老 zip 没有可靠版本字段，不猜）；许可只预选空模板', () => {
    const base = { files: [] };
    expect(zipPublishDefaults('/tmp/a.zip', base, null)).toMatchObject({
      version: '1.0.0',
      summary: '',
      licenseKind: 'none',
      author: '',
    });
    expect(
      zipPublishDefaults('/tmp/a.zip', base, {
        author: null,
        authorCandidate: null,
        updated: null,
        license: { kind: 'template-only', file: 'ライセンステンプレ.txt' },
        readmeFiles: [],
      }).licenseKind,
    ).toBe('template');
  });

  it('作者只取高置信署名；标题式候选不自动采用', () => {
    const high = zipPublishDefaults('/tmp/a.zip', { files: [] }, {
      author: { value: '舩 弦五郎', file: 'readme.txt', line: 2 },
      authorCandidate: null,
      updated: null,
      license: { kind: 'none' },
      readmeFiles: ['readme.txt'],
    });
    expect(high.author).toBe('舩 弦五郎');
    const candidate = zipPublishDefaults('/tmp/a.zip', { files: [] }, {
      author: null,
      authorCandidate: { value: '舩 弦五郎', file: 'readme.txt', line: 2 },
      updated: null,
      license: { kind: 'none' },
      readmeFiles: ['readme.txt'],
    });
    expect(candidate.author).toBe('');
  });
});

/* ------------------------------ 许可投影 ------------------------------ */

describe('许可选项 · 表只有一个真源（licenses.ts）', () => {
  it('licenseOptions 是 LICENSE_CHOICES 的逐项投影（顺序不变）', () => {
    const options = licenseOptions();
    expect(options.map((o) => o.value)).toEqual(LICENSE_CHOICES.map((c) => c.kind));
    expect(options.map((o) => o.label)).toEqual(LICENSE_CHOICES.map((c) => c.label));
  });

  it('hint / label 查表', () => {
    expect(licenseHintOf('mit')).toBe(LICENSE_CHOICES.find((c) => c.kind === 'mit')!.hint);
    expect(licenseLabelOf('ltol')).toBe(LICENSE_CHOICES.find((c) => c.kind === 'ltol')!.label);
    expect(licenseHintOf('none').length).toBeGreaterThan(0);
  });

  it('pack.json.license 是许可名，不是下拉里的操作说明', () => {
    // none / template 的 label 是给作者的操作说明；写进清单会被市场当成条款名
    expect(licenseNameOf('none')).toBe('保留所有权利（未生成 LICENSE 文件）');
    expect(licenseNameOf('template')).toBe('自定义条款（见 LICENSE）');
    expect(licenseNameOf('none')).not.toBe(licenseLabelOf('none'));
    expect(licenseNameOf('template')).not.toBe(licenseLabelOf('template'));
    // 其余选项的 label 本身就是协议名，原样沿用
    for (const kind of ['mit', 'bsd-2-clause', 'isc', 'cc-by-nc-4.0', 'ltol'] as const) {
      expect(licenseNameOf(kind)).toBe(licenseLabelOf(kind));
    }
  });
});

/* ------------------------------ 制品计划 → 草案文件 ------------------------------ */

describe('draftFilesOf · 制品计划换形状（不读盘、不改字节）', () => {
  it('relPath 与字节原样搬进草案（.kojo 已在计划层转成 .ERB）', () => {
    const plan: Pick<ArtifactPlan, 'entries'> = {
      entries: [entryOf('事件.ERB', 'PRINTL A\n'), entryOf('子目录/说明.txt', '原样')],
    };
    const files = draftFilesOf(plan);
    expect(files.map((f) => f.path)).toEqual(['事件.ERB', '子目录/说明.txt']);
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe('PRINTL A\n');
    expect(new TextDecoder().decode(files[1]!.bytes)).toBe('原样');
  });

  it('空计划直接抛——发一个空包没有意义，让作者在上传前听到人话', () => {
    expect(() => draftFilesOf({ entries: [] })).toThrow('没有可发布的文件');
  });
});

describe('buildPublishDraft · 组装市场草案', () => {
  const files: MarketPackDraftFile[] = [{ path: '事件.ERB', bytes: new TextEncoder().encode('x\n') }];

  it('字符串去空白、license 写许可名、kind 恒为 kojo-pack', () => {
    const draft = buildPublishDraft(
      {
        packId: ' kojo.p1.1 ',
        version: ' 1.0.0 ',
        name: ' 某口上 ',
        author: ' 某作者 ',
        licenseKind: 'mit',
        redistribute: true,
        summary: '  ',
      },
      files,
    );
    expect(draft).toMatchObject({
      kind: 'kojo-pack',
      id: 'kojo.p1.1',
      version: '1.0.0',
      name: '某口上',
      author: '某作者',
      license: licenseNameOf('mit'),
      redistribute: true,
    });
    expect(draft.files).toBe(files);
    // 空简介 = 作者没填，不写空串（"没这一项"与"填了一个空"不是一回事）
    expect('summary' in draft).toBe(false);
    // minAppVersion 不写：缺省由服务注入的 appVersion 派生（版本真源只在应用清单）
    expect('minAppVersion' in draft).toBe(false);
  });

  it('非空简介才带上；redistribute 原样透传（false 由服务侧预校验拒）', () => {
    const draft = buildPublishDraft(
      {
        packId: 'kojo.p1.1',
        version: '1.0.0',
        name: '某口上',
        author: '某作者',
        licenseKind: 'none',
        redistribute: false,
        summary: ' 一封短信 ',
      },
      files,
    );
    expect(draft.summary).toBe('一封短信');
    expect(draft.redistribute).toBe(false);
  });
});

/* ------------------------------ 进度与能力 ------------------------------ */

describe('进度文案 · 百分比只在总量已知时出现', () => {
  it('正常换算进 0–100 并向下取整；越界夹取', () => {
    expect(progressPercent({ sentBytes: 0, totalBytes: 100 })).toBe(0);
    expect(progressPercent({ sentBytes: 50, totalBytes: 100 })).toBe(50);
    expect(progressPercent({ sentBytes: 150, totalBytes: 100 })).toBe(100);
    expect(progressPercent({ sentBytes: -1, totalBytes: 100 })).toBe(0);
  });

  it('总字节未知/为 0 → 0%（不除零、不画假进度）', () => {
    expect(progressPercent({ sentBytes: 10, totalBytes: 0 })).toBe(0);
    expect(progressPercent({ sentBytes: 10, totalBytes: Number.NaN })).toBe(0);
  });

  it('人话按量级选单位；总量未知时只报"已发送"', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.00 MB');
    const known = progressLabel({ sentBytes: 1024, totalBytes: 2048 });
    expect(known).toContain('50%');
    expect(known).toContain('1.0 KB');
    expect(progressLabel({ sentBytes: 1024, totalBytes: 0 })).toContain('已发送');
  });
});

describe('发布能力三态 · 不许静默', () => {
  it('无市场 / 旧版服务缺 publishPack / 就绪', () => {
    expect(publishCapabilityOf(null)).toBe('no-market');
    expect(publishCapabilityOf({} as MarketService)).toBe('no-direct');
    expect(
      publishCapabilityOf({ publishPack: async () => ({ ok: true }) } as unknown as MarketService),
    ).toBe('ready');
  });

  it('两种不可用态都有一句人话（含下一步怎么做）；就绪态不显示空行', () => {
    expect(publishCapabilityNote('no-market')).toContain('口上市场');
    expect(publishCapabilityNote('no-market')).toContain('启用');
    expect(publishCapabilityNote('no-direct')).toContain('zip');
    expect(publishCapabilityNote('ready')).toBe('');
  });
});
