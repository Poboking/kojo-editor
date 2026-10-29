/**
 * 注释文档链接（批次十 S12）单测：
 * 识别只落在注释（**行注释起头逐语言**：ERB `;` / kojo2 `//`）、相对路径按 model 目录与
 * 项目根两路解析、存在性裁决只读、跨根回退，以及 8 类注释噪音不产出链接。
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

const ERB_LANG = 'kojo-erb';
const KOJO2_LANG = 'kojo2';
/**
 * 2.0 文件的路径。供给器的语言口径按**扩展名**判（不看 model 语言 id），所以"走 kojo2
 * 注释口径"的用例必须给 `.kojo2` 路径——语言 id 与路径不一致时以路径为准。
 */
const KOJO2_MODEL_PATH = 'C:\\proj\\pkg\\a\\foo.kojo2';

function fakeModel(
  text: string,
  fsPath: string,
  languageId: string = ERB_LANG,
): Monaco.editor.ITextModel {
  return {
    getValue: () => text,
    getLanguageId: () => languageId,
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
  languageId: string = ERB_LANG,
): Promise<Monaco.languages.ILink[]> {
  const { monaco, registrations } = fakeMonaco();
  installDocumentLinks(monaco, {
    ...host,
    existsPath: host.existsPath ?? (() => false),
  });
  const provider = registrations[0]!.provider;
  const list = await Promise.resolve(
    provider.provideLinks!(fakeModel(text, fsPath, languageId), {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    } as unknown as Monaco.CancellationToken) as
      | Monaco.languages.ILinksList
      | Promise<Monaco.languages.ILinksList>,
  );
  return list.links;
}

describe('识别范围：注释起头逐语言（ERB `;` / kojo2 `//`）', () => {
  it('ERB：`;` 行注释与块注释都覆盖，`#` 预处理行与台词行不产链接', () => {
    const text = [
      '; 参考 https://example.com/a?b=1 与 ./data/场景.ERB',
      '/* 块注释 foo\\bar.erb */',
      '#DIM NAME, 1 ; ./directive.erb', // `#` 是预处理指令，不是注释
      '@口上「https://evil.example/x 与 ./台词.ERB」',
    ].join('\n');
    expect(extractLinkCandidates(text, 'erb').map((c) => [c.kind, c.text])).toEqual([
      ['url', 'https://example.com/a?b=1'],
      ['path', './data/场景.ERB'],
      ['path', 'foo\\bar.erb'],
    ]);
  });

  it('kojo2：整行 `//` 行注释覆盖；`#` 声明行与 `;` 行都不是注释', () => {
    const text = [
      '// see ../COMMON.ERB',
      '# 设 图 字符串 = "data/立绘.csv"',
      '; ./legacy.erb',
      '> 正文里的 ../不认.erb',
    ].join('\n');
    expect(extractLinkCandidates(text, 'kojo2').map((c) => c.text)).toEqual(['../COMMON.ERB']);
  });

  it('`# 设 图 字符串 = "data/立绘.csv"` 在 kojo2 下零候选（改前是三语并集 ⇒ 长出假链接）', async () => {
    const text = '# 设 图 字符串 = "data/立绘.csv"';
    expect(extractLinkCandidates(text, 'kojo2')).toEqual([]);
    // 探针全真也不成链（说明是"没被当注释"，不是"存在性没命中"）
    const links = await linksFor(text, { existsPath: () => true }, KOJO2_MODEL_PATH, KOJO2_LANG);
    expect(links).toEqual([]);
  });

  it('块注释跨行仍识别路径（两种语言同一块注释口径）', () => {
    const text = ['/* 第一行', ' * ./notes.md', ' */', '; 参考 ./common/COMMON.ERB'].join('\n');
    expect(extractLinkCandidates(text, 'erb').map((c) => c.text)).toEqual([
      './notes.md',
      './common/COMMON.ERB',
    ]);
  });

  it('引号 / 反引号 / 「」「」里的带空格文件名可识别（kojo2 注释）', () => {
    const text = '// 见 "./data/我的 文件.ERB" 与 `common\\有 空格.erb` 与 「说明 文档.md」';
    expect(extractLinkCandidates(text, 'kojo2').map((c) => c.text)).toEqual([
      './data/我的 文件.ERB',
      'common\\有 空格.erb',
      '说明 文档.md',
    ]);
  });

  it('行尾 `//` 不是注释（kojo2 只认行首整行注释）', () => {
    expect(extractLinkCandidates('let x = ./a.erb // ./b.erb', 'kojo2')).toEqual([]);
    expect(extractLinkCandidates('let x = ./a.erb // ./b.erb', 'erb')).toEqual([]);
  });

  it('scanCommentSpans 逐语言各一套起头', () => {
    expect(scanCommentSpans('; a\n// b\n# c', 'erb')).toHaveLength(1);
    expect(scanCommentSpans('; a\n// b\n# c', 'kojo2')).toHaveLength(1);
    expect(scanCommentSpans('// a\n# b', 'kojo2')).toHaveLength(1);
    expect(scanCommentSpans('# a\n; b', 'erb')).toHaveLength(1);
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
    const text = '; 见 ../COMMON.ERB 和 https://example.com/x';
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

  it('只注册 ERB 与 kojo2；不存在的路径不产出链接（两门语言的注释都在供给器里生效）', async () => {
    const { monaco, registrations } = fakeMonaco();
    installDocumentLinks(monaco, { existsPath: () => false, projectRoot: () => 'C:\\proj' });
    expect(registrations).toHaveLength(1);
    expect(registrations[0]!.languages).toEqual(['kojo-erb', 'kojo2']);
    expect(await linksFor('; ./missing.erb', { existsPath: () => false })).toEqual([]);
    // kojo2 的 `//` 行注释经同一个 provider 生效（扩展名判语言 ⇒ `.kojo2` 路径才走 2.0 口径）
    const hit = await linksFor(
      '// ./data/one.erb',
      { existsPath: async (path) => path === 'C:\\proj\\pkg\\a\\data\\one.erb' },
      KOJO2_MODEL_PATH,
      KOJO2_LANG,
    );
    expect(hit).toHaveLength(1);
    // 反例：语言 id 是 kojo2、但路径是 `.erb` ⇒ 按 ERB 口径（`//` 不是注释，零链接）
    expect(
      await linksFor('// ./data/one.erb', { existsPath: async () => true }, WINDOWS_CONTEXT.modelPath, KOJO2_LANG),
    ).toEqual([]);
  });

  it('非 file 的 model 可由宿主 filePathOf 提供路径', async () => {
    const links = await linksFor(
      '; ./data/one.erb',
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
    '; 邮箱 foo@example.com',
    '; 版本 v1.2.3',
    '; 分数 50/100',
    '; 时间 12:30',
    '; 域名 example.com',
    '; 普通中文词语 你好',
    '; 指令 #DIM NAME, 1',
    '; 数学 a+b=c',
    '@口上 你好//再见',
  ].join('\n');

  it('即使存在性探针全部为真，也不把噪音当链接', async () => {
    expect(extractLinkCandidates(noise, 'erb')).toEqual([]);
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
