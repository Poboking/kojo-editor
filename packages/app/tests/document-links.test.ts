/**
 * 注释文档链接（批次十 S12）单测：
 * 识别只落在注释、相对路径按 model 目录与项目根两路解析、存在性裁决只读、跨根回退、
 * 以及 8 类注释噪音不产出链接。
 */
import { describe, expect, it, vi } from 'vitest';
import type * as Monaco from '../src/monaco/entry';
import {
  DOCUMENT_LINK_OPEN_COMMAND,
  documentLinkCommandUrl,
  extractLinkCandidates,
  installDocumentLinks,
  resolveExistingPath,
  resolvePathCandidates,
  scanCommentSpans,
  type DocumentLinksHost,
} from '../src/monaco/document-links';

const WINDOWS_CONTEXT = {
  modelPath: 'C:\\proj\\pkg\\a\\foo.erb',
  projectRoot: 'C:\\proj',
};

function fakeModel(text: string, fsPath: string): Monaco.editor.ITextModel {
  return {
    getValue: () => text,
    getPositionAt: (offset: number) => {
      const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
      const lines = before.split('\n');
      return { lineNumber: lines.length, column: lines[lines.length - 1]!.length + 1 };
    },
    uri: { scheme: 'file', fsPath, path: fsPath },
  } as unknown as Monaco.editor.ITextModel;
}

function fakeMonaco(): {
  monaco: typeof Monaco;
  registrations: Array<{
    languages: Monaco.languages.LanguageSelector;
    provider: Monaco.languages.LinkProvider;
  }>;
} {
  const registrations: Array<{
    languages: Monaco.languages.LanguageSelector;
    provider: Monaco.languages.LinkProvider;
  }> = [];
  const monaco = {
    languages: {
      registerLinkProvider: (
        languages: Monaco.languages.LanguageSelector,
        provider: Monaco.languages.LinkProvider,
      ) => {
        registrations.push({ languages, provider });
        return { dispose: () => undefined };
      },
    },
  } as unknown as typeof Monaco;
  return { monaco, registrations };
}

async function linksFor(
  text: string,
  host: Omit<DocumentLinksHost, 'existsPath'> & { existsPath?: DocumentLinksHost['existsPath'] },
  fsPath = WINDOWS_CONTEXT.modelPath,
): Promise<Monaco.languages.ILink[]> {
  const { monaco, registrations } = fakeMonaco();
  installDocumentLinks(monaco, {
    ...host,
    existsPath: host.existsPath ?? (() => false),
  });
  const provider = registrations[0]!.provider;
  const list = await Promise.resolve(
    provider.provideLinks!(fakeModel(text, fsPath), {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as unknown as Monaco.CancellationToken) as
      | Monaco.languages.ILinksList
      | Promise<Monaco.languages.ILinksList>,
  );
  return list.links;
}

describe('识别范围：注释、URL、相对路径', () => {
  it('行注释 # / // 与块注释都覆盖，台词行不产链接', () => {
    const text = [
      '# 参考 https://example.com/a?b=1 与 ./data/场景.ERB',
      '// see ../COMMON.ERB',
      '/* 块注释 foo\\bar.erb */',
      '@口上「https://evil.example/x 与 ./台词.ERB」',
    ].join('\n');
    const found = extractLinkCandidates(text);
    expect(found.map((c) => [c.kind, c.text])).toEqual([
      ['url', 'https://example.com/a?b=1'],
      ['path', './data/场景.ERB'],
      ['path', '../COMMON.ERB'],
      ['path', 'foo\\bar.erb'],
    ]);
  });

  it('块注释跨行仍识别路径，ERB 行首分号注释也覆盖', () => {
    const text = ['/* 第一行', ' * ./notes.md', ' */', '; 参考 ./common/COMMON.ERB'].join('\n');
    expect(extractLinkCandidates(text).map((c) => c.text)).toEqual(['./notes.md', './common/COMMON.ERB']);
  });

  it('引号 / 反引号 / 「」「」里的带空格文件名可识别', () => {
    const text = '# 见 "./data/我的 文件.ERB" 与 `common\\有 空格.erb` 与 「说明 文档.md」';
    expect(extractLinkCandidates(text).map((c) => c.text)).toEqual([
      './data/我的 文件.ERB',
      'common\\有 空格.erb',
      '说明 文档.md',
    ]);
  });

  it('注释区间只包含注释本身（行尾代码里的 / 不参与）', () => {
    const spans = scanCommentSpans('# a\nlet x = 1 // 这不是行注释\n/* b */');
    expect(spans).toHaveLength(2);
    expect(extractLinkCandidates('let x = ./a.erb // ./b.erb').filter((c) => c.kind === 'path').length).toBe(0);
  });
});

describe('路径解析：model 目录、项目根与分隔符', () => {
  it('model 目录优先、项目根兜底，两种分隔符混用也归一', () => {
    expect(resolvePathCandidates('./data/场景.ERB', WINDOWS_CONTEXT)).toEqual([
      'C:\\proj\\pkg\\a\\data\\场景.ERB',
      'C:\\proj\\data\\场景.ERB',
    ]);
    expect(resolvePathCandidates('..\\COMMON.ERB', WINDOWS_CONTEXT)).toEqual([
      'C:\\proj\\pkg\\COMMON.ERB',
      'C:\\COMMON.ERB',
    ]);
    expect(resolvePathCandidates('common\\资料 文件.erb', WINDOWS_CONTEXT)[1]).toBe(
      'C:\\proj\\common\\资料 文件.erb',
    );
  });

  it('POSIX 风格目录也按两个根解析', () => {
    const context = { modelPath: '/home/me/proj/char/foo.erb', projectRoot: '/home/me/proj' };
    expect(resolvePathCandidates('../COMMON.ERB', context)).toEqual([
      '/home/me/proj/COMMON.ERB',
      '/home/me/COMMON.ERB',
    ]);
  });
});

describe('存在性裁决：只读探针、跨根回退、空格回退', () => {
  it('model 目录命中即停，探针只收到解析后的路径', async () => {
    const probe = vi.fn(async (path: string) => path === 'C:\\proj\\pkg\\a\\data\\场景.ERB');
    const resolved = await resolveExistingPath('./data/场景.ERB', WINDOWS_CONTEXT, probe);
    expect(resolved).toEqual({ path: 'C:\\proj\\pkg\\a\\data\\场景.ERB', matchedLength: './data/场景.ERB'.length });
    expect(probe.mock.calls.map(([path]) => path)).toEqual(['C:\\proj\\pkg\\a\\data\\场景.ERB']);
  });

  it('model 目录落空时回退项目根', async () => {
    const probe = vi.fn(async (path: string) => path === 'C:\\proj\\common\\COMMON.ERB');
    const resolved = await resolveExistingPath('common\\COMMON.ERB', WINDOWS_CONTEXT, probe);
    expect(resolved?.path).toBe('C:\\proj\\common\\COMMON.ERB');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('带空格的裸写路径可截掉行尾说明后再命中', async () => {
    const target = 'C:\\proj\\pkg\\a\\data\\我的 文件.ERB';
    const probe = vi.fn(async (path: string) => path === target);
    const resolved = await resolveExistingPath('./data/我的 文件.ERB 参见', WINDOWS_CONTEXT, probe);
    expect(resolved).toEqual({ path: target, matchedLength: './data/我的 文件.ERB'.length });
  });

  it('探针抛错按不存在处理', async () => {
    const probe = vi.fn(async () => {
      throw new Error('io down');
    });
    await expect(resolveExistingPath('./a.erb', WINDOWS_CONTEXT, probe)).resolves.toBeNull();
  });
});

describe('供给器接线：链接形态与命令落点', () => {
  it('URL 用原样 http(s)，相对路径用既有定位命令并收窄区间', async () => {
    const text = '# 见 ../COMMON.ERB 和 https://example.com/x';
    const links = await linksFor(text, {
      projectRoot: () => WINDOWS_CONTEXT.projectRoot,
      existsPath: async (path) => path === 'C:\\proj\\pkg\\COMMON.ERB',
    });
    expect(links).toHaveLength(2);
    const urlLink = links.find((link) => link.url === 'https://example.com/x');
    expect(urlLink).toBeDefined();
    const pathLink = links.find((link) => String(link.url).startsWith('command:'))!;
    expect(pathLink.url).toMatch(/^command:kojo\.codeLens\.execute\?/);
    const query = decodeURIComponent((pathLink.url as string).slice((pathLink.url as string).indexOf('?') + 1));
    expect(JSON.parse(query)).toEqual([{ filePath: 'C:\\proj\\pkg\\COMMON.ERB', line: 1 }]);
    expect(pathLink.range.startLineNumber).toBe(1);
    expect(pathLink.range.startColumn).toBe(5);
    expect(pathLink.range.endColumn).toBe(5 + '../COMMON.ERB'.length);
  });

  it('只注册 ERB 与 kojo2；不存在的路径不产出链接', async () => {
    const { monaco, registrations } = fakeMonaco();
    installDocumentLinks(monaco, { existsPath: () => false, projectRoot: () => 'C:\\proj' });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.languages).toEqual(['kojo-erb', 'kojo2']);
    const links = await linksFor('// ./missing.erb', { existsPath: () => false });
    expect(links).toEqual([]);
  });

  it('非 file 的 model 可由宿主 filePathOf 提供路径', async () => {
    const links = await linksFor(
      '# ./data/one.erb',
      {
        filePathOf: () => WINDOWS_CONTEXT.modelPath,
        projectRoot: () => WINDOWS_CONTEXT.projectRoot,
        existsPath: async (path) => path === 'C:\\proj\\pkg\\a\\data\\one.erb',
      },
      'inmemory://model/1',
    );
    expect(links).toHaveLength(1);
  });

  it('命令参数编码走 JSON，缺省命令 id 与 code lens 定位命令一致', () => {
    expect(DOCUMENT_LINK_OPEN_COMMAND).toBe('kojo.codeLens.execute');
    const url = documentLinkCommandUrl({ filePath: 'C:\\proj\\a b.erb' });
    expect(JSON.parse(decodeURIComponent(url.slice(url.indexOf('?') + 1)))).toEqual([
      { filePath: 'C:\\proj\\a b.erb', line: 1 },
    ]);
  });
});

describe('8 类非链接噪音', () => {
  const noise = [
    '# 邮箱 foo@example.com',
    '# 版本 v1.2.3',
    '# 分数 50/100',
    '# 时间 12:30',
    '# 域名 example.com',
    '# 普通中文词语 你好',
    '# 指令 #DIM NAME, 1',
    '# 数学 a+b=c',
    '@口上 你好//再见',
  ].join('\n');

  it('即使存在性探针全部为真，也不把噪音当链接', async () => {
    expect(extractLinkCandidates(noise)).toEqual([]);
    const links = await linksFor(noise, {
      projectRoot: () => WINDOWS_CONTEXT.projectRoot,
      existsPath: () => true,
    });
    expect(links).toEqual([]);
  });

  it('台词行里的 URL 不识别（只认注释）', async () => {
    const links = await linksFor('@口上「https://example.com/x」', {
      projectRoot: () => WINDOWS_CONTEXT.projectRoot,
      existsPath: () => true,
    });
    expect(links).toEqual([]);
  });
});
