/**
 * 口上 XML：解析 / 编码 / 索引 / 服务四层判据。
 *
 * 合成样本优先（可在任何机器上跑）；真盘读数单列一组，以 `D:/Game/erafl` 存在为守卫。
 * 断言口径：**数条数、数字符、数诊断**——"能解析"这种模糊话不算判据。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join as nodeJoin } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FileIO } from '@kojo/plugin-api';
import { decodeKojoXmlBytes, detectKojoXmlEncoding } from '../src/kojo-xml/encoding';
import { buildKojoXmlIndex } from '../src/kojo-xml/index-build';
import { decodeKojoXmlEntities, parseKojoXmlText } from '../src/kojo-xml/parse';
import { KOJO_XML_ATTRIBUTES, buildKojoXmlSchema } from '../src/kojo-xml/schema';
import { charaNoFromKojoPath, createKojoXmlService } from '../src/kojo-xml/service';

const silentLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const DATA_XML = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<data>',
  '  <command com="300" name="会話" kojoPlace="TOP" priority="1">',
  '    <contents>「你好」</contents>',
  '  </command>',
  '  <command com="300" name="会話" kojoPlace="TOP" priority="2" isFall="LOVER" eval="{TSTR:X == &quot;Y&quot;}">',
  '    <contents>「第二行」',
  '「第三行」</contents>',
  '  </command>',
  '</data>',
  '',
].join('\r\n');

describe('parseKojoXmlText —— 现行格式', () => {
  const file = parseKojoXmlText({ path: 'a.xml', text: DATA_XML, encoding: 'utf-8', charaNo: 7 });

  it('两条 command、格式 data、无诊断', () => {
    expect(file.format).toBe('data');
    expect(file.commands.length).toBe(2);
    expect(file.diagnostics).toEqual([]);
  });

  it('属性原样字典 + 实体解码（eval 里的 &quot; 解回真引号）', () => {
    const attrs = file.commands[1]!.attrs;
    expect(attrs['com']).toBe('300');
    expect(attrs['isFall']).toBe('LOVER');
    expect(attrs['eval']).toBe('{TSTR:X == "Y"}');
  });

  it('正文保留换行（CRLF 原样），span 可回指原文', () => {
    const cmd = file.commands[1]!;
    expect(cmd.text).toBe('「第二行」\r\n「第三行」');
    const s = cmd.contentSpan!;
    const lines = DATA_XML.split('\r\n');
    expect(lines[s.start.line - 1]!.slice(s.start.column - 1)).toContain('「第二行」');
  });

  it('eol 报 crlf', () => {
    expect(file.eol).toBe('crlf');
  });
});

describe('parseKojoXmlText —— 旧格式 kojodef', () => {
  const legacy = [
    '<kojodef>',
    '\t<command com="300" name="会話">',
    '\t\t<kojo place="TOP" isFall="恋慕" priority="1">「旧格式」</kojo>',
    '\t</command>',
    '</kojodef>',
  ].join('\n');
  const file = parseKojoXmlText({ path: 'b.xml', text: legacy, encoding: 'utf-8', charaNo: null });

  it('format=kojodef，正文取 <kojo>，属性合并到 command 层', () => {
    expect(file.format).toBe('kojodef');
    expect(file.commands.length).toBe(1);
    expect(file.commands[0]!.text).toBe('「旧格式」');
    expect(file.commands[0]!.attrs['place']).toBe('TOP');
    expect(file.commands[0]!.attrs['isFall']).toBe('恋慕');
  });
});

describe('parseKojoXmlText —— 容错（坏文件不许抛）', () => {
  it('未闭合标签 → error 诊断；已闭合的照出、半截的那条也出（编辑期可定位优于丢弃）', () => {
    const text = '<data><command com="1"><contents>「甲」</contents></command><command com="2"><contents>「乙」';
    const file = parseKojoXmlText({ path: 'c.xml', text, encoding: 'utf-8', charaNo: null });
    expect(file.commands.length).toBe(2);
    expect(file.commands[1]!.text).toBe('「乙」');
    expect(file.diagnostics.some((d) => d.code === 'kojo-xml.syntax.unclosed-tag')).toBe(true);
  });

  it('空串 → 一条 root.missing，零条目，不抛', () => {
    const file = parseKojoXmlText({ path: 'd.xml', text: '', encoding: 'utf-8', charaNo: null });
    expect(file.commands.length).toBe(0);
    expect(file.diagnostics[0]!.code).toBe('kojo-xml.root.missing');
  });

  it('拼错的 <command_> 单独报 command-misspelled（引擎不认，条目会静默消失）', () => {
    const text = '<data><command_ com="1"><contents>「甲」</contents></command_></data>';
    const file = parseKojoXmlText({ path: 'e.xml', text, encoding: 'utf-8', charaNo: null });
    expect(file.commands.length).toBe(0);
    expect(file.diagnostics.some((d) => d.code === 'kojo-xml.tag.command-misspelled')).toBe(true);
  });

  it('注释掉的口上不算条目', () => {
    const text = '<data><!-- <command com="9"><contents>「注释」</contents></command> --></data>';
    expect(parseKojoXmlText({ path: 'f.xml', text, encoding: 'utf-8', charaNo: null }).commands.length).toBe(0);
  });
});

describe('编码判定 —— BOM 优先于声明', () => {
  it('UTF-16LE BOM 的字节被认成 utf-16le 并解出原文', () => {
    const bytes = Buffer.from('<?xml version="1.0" encoding="utf-8"?><data/>', 'utf16le');
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
    expect(detectKojoXmlEncoding(withBom).encoding).toBe('utf-16le');
    const { text, encoding } = decodeKojoXmlBytes(withBom);
    expect(encoding).toBe('utf-16le');
    expect(text.startsWith('<?xml')).toBe(true);
  });

  it('UTF-8 BOM 认成 utf-8-bom，且不把 BOM 留在正文里', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<data/>', 'utf8')]);
    const { text, encoding } = decodeKojoXmlBytes(bytes);
    expect(encoding).toBe('utf-8-bom');
    expect(text).toBe('<data/>');
  });

  it('UTF-16 文件声明 utf-8 → 一条 encoding.mismatch（真盘那 9 份就是这种）', () => {
    const bytes = Buffer.from('<?xml version="1.0" encoding="utf-8"?><data><command com="1"><contents>x</contents></command></data>', 'utf16le');
    const withBom = Buffer.concat([Buffer.from([0xff, 0xfe]), bytes]);
    const { text, encoding } = decodeKojoXmlBytes(withBom);
    const file = parseKojoXmlText({ path: 'g.xml', text, encoding, charaNo: null });
    expect(file.diagnostics.some((d) => d.code === 'kojo-xml.encoding.mismatch')).toBe(true);
    expect(file.commands.length).toBe(1);
  });

  it('实体解码：&lt; &amp; &#12354; 与未知实体原样保留', () => {
    expect(decodeKojoXmlEntities('&lt;&amp;&#12354;&foo;')).toBe('<&あ&foo;');
  });
});

describe('buildKojoXmlIndex —— 聚合', () => {
  const f1 = parseKojoXmlText({ path: 'p/1_a.xml', text: DATA_XML, encoding: 'utf-8', charaNo: 7 });
  const f2 = parseKojoXmlText({
    path: 'p/2_b.xml',
    text: '<data><command com="ANY"><contents>x</contents></command></data>',
    encoding: 'utf-8',
    charaNo: 9,
  });
  const index = buildKojoXmlIndex([f2, f1], 1234);

  it('文件按路径排序、条目总数与角色分组正确', () => {
    expect(index.files.map((f) => f.path)).toEqual(['p/1_a.xml', 'p/2_b.xml']);
    expect(index.commandCount).toBe(3);
    expect([...index.byChara.keys()]).toEqual([7, 9]);
  });

  it('byCom 计数（含 ANY）', () => {
    expect(index.byCom.get('300')).toBe(2);
    expect(index.byCom.get('ANY')).toBe(1);
  });

  it('scannedAt 用传入值（可复现）', () => {
    expect(index.scannedAt).toBe(1234);
  });
});

describe('规格表', () => {
  it('属性表含 com/name/kojoPlace/eval，且 kojoPlace 有 6 个位置', () => {
    const names = KOJO_XML_ATTRIBUTES.map((a) => a.name);
    expect(names).toContain('com');
    expect(names).toContain('eval');
    const place = KOJO_XML_ATTRIBUTES.find((a) => a.name === 'kojoPlace')!;
    expect(place.values).toHaveLength(6);
  });

  it('com 表：符号表兜底 + 外部注入优先', () => {
    const schema = buildKojoXmlSchema([{ code: '300', label: '会話（CSV 权威）' }]);
    expect(schema.commands.find((c) => c.code === '300')!.label).toBe('会話（CSV 权威）');
    expect(schema.commands.some((c) => c.code === 'ANY')).toBe(true);
    expect(schema.places.length).toBe(6);
  });
});

describe('charaNoFromKojoPath', () => {
  it('目录名带编号 / 文件名带 KOJO_K 编号 / 都没有', () => {
    expect(charaNoFromKojoPath('D:/g/ERB/口上/1099_うふふお姉さん/うふふお姉さん口上.xml')).toBe(1099);
    expect(charaNoFromKojoPath('D:/g/ERB/口上/5192_主人公口上_汎用/x.xml')).toBe(5192);
    expect(charaNoFromKojoPath('D:/g/ERB/口上/KOJO_K1000_COM.xml')).toBe(1000);
    expect(charaNoFromKojoPath('D:/g/ERB/口上/共用.xml')).toBeNull();
  });
});

/** 内存盘：只实现服务用到的 walkDir / readBytes / readBytesMany */
function memIo(files: Record<string, Uint8Array>, roots: readonly string[]): FileIO {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  return {
    walkDir: async (root: string) => {
      const prefix = `${norm(root)}/`;
      return [...table.keys()]
        .filter((p) => p.startsWith(prefix))
        .map((p) => ({ name: p.slice(p.lastIndexOf('/') + 1), path: p, isDirectory: false }));
    },
    readBytes: async (p: string) => {
      const hit = table.get(norm(p));
      if (!hit) throw new Error(`ENOENT ${p}`);
      return hit;
    },
    readBytesMany: async (ps: readonly string[]) =>
      ps.map((p) => table.get(norm(p)) ?? null),
  } as unknown as FileIO;
}

describe('createKojoXmlService —— 生命周期', () => {
  const root = 'D:/mem/erafl/ERB/口上';
  const io = memIo(
    {
      [`${root}/7_测试/KOJO_K7_COM.xml`]: Buffer.from(DATA_XML, 'utf8'),
      [`${root}/9_别的/x.xml`]: Buffer.from('<data><command com="ANY"><contents>y</contents></command></data>', 'utf8'),
    },
    [root],
  );

  it('未 refresh 时 index 为 null（不静默给空索引）', () => {
    const svc = createKojoXmlService({ io, log: silentLog, roots: () => [root] });
    expect(svc.index()).toBeNull();
  });

  it('refresh 建索引：2 份 / 3 条 / 2 个角色，并通知订阅者', async () => {
    const svc = createKojoXmlService({ io, log: silentLog, roots: () => [root] });
    let notified = 0;
    svc.subscribe(() => notified++);
    const index = await svc.refresh();
    expect(index!.files.length).toBe(2);
    expect(index!.commandCount).toBe(3);
    expect(index!.byChara.size).toBe(2);
    expect(notified).toBe(1);
    expect(svc.file(`${root}/7_测试/KOJO_K7_COM.xml`)!.charaNo).toBe(7);
  });

  it('dispose 后索引清空（项目关闭不留残留）', async () => {
    const svc = createKojoXmlService({ io, log: silentLog, roots: () => [root] });
    await svc.refresh();
    svc.dispose();
    expect(svc.index()).toBeNull();
  });

  it('没有 XML 的工程：refresh 返回 null 而不是抛', async () => {
    const svc = createKojoXmlService({ io, log: silentLog, roots: () => ['D:/mem/empty'] });
    expect(await svc.refresh()).toBeNull();
  });

  it('单份读失败不拖垮整批', async () => {
    const partial = {
      ...io,
      readBytesMany: async (ps: readonly string[]) => ps.map((p, i) => (i === 0 ? null : Buffer.from('<data/>'))),
    } as unknown as FileIO;
    const svc = createKojoXmlService({ io: partial, log: silentLog, roots: () => [root] });
    const index = await svc.refresh();
    expect(index!.files.length).toBe(1);
  });
});

describe('真盘读数（守卫：D:/Game/erafl 存在才跑）', () => {
  const KOJO_ROOT = 'D:/Game/erafl/ERB/口上';
  const hasCorpus = existsSync(KOJO_ROOT);

  it.skipIf(!hasCorpus)('293 份 XML 全部可读：解析成功 293 / 条目 ≥ 61,000 / 角色 144 组内', () => {
    const paths: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const full = nodeJoin(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (/\.xml$/i.test(ent.name)) paths.push(full);
      }
    };
    walk(KOJO_ROOT);
    expect(paths.length).toBe(293);

    let commands = 0;
    let encodingWarn = 0;
    for (const p of paths) {
      const { text, encoding } = decodeKojoXmlBytes(readFileSync(p));
      const file = parseKojoXmlText({ path: p, text, encoding, charaNo: charaNoFromKojoPath(p) });
      commands += file.commands.length;
      if (file.diagnostics.some((d) => d.code === 'kojo-xml.encoding.mismatch')) encodingWarn++;
    }
    expect(commands).toBeGreaterThanOrEqual(61_000);
    // 9 份 UTF-16 声明 utf-8 的样本必须被认出来（少一份说明 BOM 判据退化了）
    expect(encodingWarn).toBe(9);
    expect(statSync(KOJO_ROOT).isDirectory()).toBe(true);
  });
});
