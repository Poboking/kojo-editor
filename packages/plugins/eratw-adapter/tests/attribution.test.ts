import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import {
  attributionMeta,
  attributionSummary,
  classifyAuxFile,
  licenseLabel,
  parseAttributionText,
  readPackageAttribution,
  type PackageAttribution,
} from '../src/attribution';

/**
 * 署名 / 授权抽取（T2）测试。
 *
 * **全部用例取自 C:\game 真实语料的 README dump**（不是编的理想形态）——
 * 本仓铁律：先测真实样本再定语义（HANDOFF §九-1 / -15）。
 * 三条从语料学到的硬规则各有一项钉死的断言，防止有人"凭直觉"放宽匹配把假阳性放回来。
 */

/* --------------------------- 文件名分类（真实形态） --------------------------- */

describe('classifyAuxFile · 真实文件名形态', () => {
  it('readme 类的野形态全部命中（大小写 / 空格 / 下划线 / 带日期 / 平假名谐音 / 中文 / 子串）', () => {
    for (const name of [
      'readme.txt',
      'README.txt',
      'ReadMe.txt',
      'Read me.txt',
      'read me.txt',
      'read_me.txt',
      'readme(2023.2.1).txt',
      'ルーミアread_me.txt',
      'れあどめ.txt',
      'りどみ.txt',
      '輝夜様口上れどめ.txt',
      '读我读我读我.txt',
      '讀我.txt',
      '讀我2.txt',
      '霊夢さんのreadme.txt',
      '無個性版readme.txt',
      'でも魅魔様のreadmeならちょっと見たいかも.txt',
      '（必看）冴月麟角色口上使用说明.txt',
      '搬运工的话.txt',
      '譯者之言.txt',
    ]) {
      expect(classifyAuxFile(name), name).toBe('readme');
    }
  });

  it('授权模板与真声明分开：ライセンステンプレ 出现 67 次，误判即"已标注授权"全假阳性', () => {
    for (const name of [
      'ライセンステンプレ.txt',
      'ライセンステンプレート.txt',
      'license_template.txt',
      '许可证声明模板.txt',
    ]) {
      expect(classifyAuxFile(name), name).toBe('license-template');
    }
    expect(classifyAuxFile('ライセンス.txt')).toBe('license');
    expect(classifyAuxFile('license.txt')).toBe('license');
    expect(classifyAuxFile('著作権表示.txt')).toBe('license');
    expect(classifyAuxFile('神奈子様口上ライセンス.txt')).toBe('license');
  });

  it('平假名谐音的长音与 め/み 变体、以及「読め」写法（首轮语料实测漏网，已通吃）', () => {
    for (const name of [
      'れあどめ.txt',
      'れあどみってほどでもない.txt',
      'りどみ.txt',
      'りーどみすちー.txt',
      'れどめ.txt',
      '＼読め～！／.txt',
      '口上说明.txt',
      '汉化说明.txt',
    ]) {
      expect(classifyAuxFile(name), name).toBe('readme');
    }
  });

  it('readme 优先于授权：「Readme！（原ライセンス）」实质是 readme，别被 license 抢走', () => {
    expect(classifyAuxFile('Readme！（原ライセンス）.txt')).toBe('readme');
  });

  it('更新历史的异体字与简繁两路全部覆盖（只写一个必漏一半）', () => {
    for (const name of [
      '更新履歴.txt',
      '更新履历.txt',
      '更新日志.txt',
      '更新情報.txt',
      '更新情报.txt',
      '更新记录.txt',
      '改版履歴.txt',
      '改版记录.txt',
      'changelog.txt',
      '汉化日志.txt',
    ]) {
      expect(classifyAuxFile(name), name).toBe('changelog');
    }
  });

  it('无关文件与 HOGE 占位（语料 21 次反例）一律不猜', () => {
    for (const name of ['HOGE', 'CFLAGいろいろ.txt', '雑記.txt', '01 イベント.ERB', '让DOKU掂掂.txt', '未开工']) {
      expect(classifyAuxFile(name), name).toBeNull();
    }
  });
});

/* --------------------------- 正文解析（三条硬规则） --------------------------- */

describe('parseAttributionText · 规则 1：模板占位按「待填说明语句」判，不按尖括号判', () => {
  it('作者：＜作者名・連絡先＞（…他人と被らないものを）是未填模板 → 不采纳', () => {
    const text = [
      ';  霊夢口上無個性版',
      ';  作者：＜作者名・連絡先＞（“XXスレ目>>123” 等でもOKなので、何か他人と被らないものを）',
      ';  ＜改変した場合はここに改変者の名前・連絡先を追加する＞',
    ].join('\n');
    expect(parseAttributionText('readme.txt', text).author).toBeNull();
  });

  it('作者：＜猫のごろごろ＞（…）是模板自带示例名（说明括注还在）→ 同样不采纳', () => {
    const text = ';  作者：＜猫のごろごろ＞（“XXスレ目>>123” 等でもOKなので、何か他人と被らないものを）';
    expect(parseAttributionText('README.txt', text).author).toBeNull();
  });

  it('作者：＜さもま＞是作者把真名填进了模板括号 → **必须采纳并剥掉括号**（只按尖括号判就会漏）', () => {
    const text = [';  TW用さとりん', ';  作者：＜さもま＞', ';'].join('\n');
    expect(parseAttributionText('ライセンス.txt', text).author).toEqual({
      value: 'さもま',
      file: 'ライセンス.txt',
      line: 2,
    });
  });

  it('汉化版模板把说明括注也翻译了 → 靠语言无关指纹（>>回帖号 / XX条目 / 等也OK）拦住', () => {
    // 语料实况（真出现过，被 corpus 基线测试逮住过一次假阳性）
    const text = '作者：＜猫呼噜＞(“XX条目>>123”等也OK，请不要和别人的方式相重合)';
    expect(parseAttributionText('readme.txt', text).author).toBeNull();
  });

  it('前导装饰（制表符 + 箭头）要清掉而不是当成非法值', () => {
    // 语料实况：作者：\t-> 全人類ノ天空録
    expect(parseAttributionText('Readme！（原ライセンス）.txt', '作者：\t-> 全人類ノ天空録').author?.value).toBe(
      '全人類ノ天空録',
    );
  });

  it('真名正常采纳，并带出处文件名与 1 基行号', () => {
    const text = ['・基本信息', 'eraTheWorld　琪露诺口上中期测试版（チルノ）', '作者：纸蛇冰沙'].join('\n');
    expect(parseAttributionText('readme.txt', text).author).toEqual({
      value: '纸蛇冰沙',
      file: 'readme.txt',
      line: 3,
    });
  });
});

describe('parseAttributionText · 规则 2：散文里的「作者」不是标签', () => {
  it('「作者は本口上が処女口上です」无冒号 → 绝不采纳为人名', () => {
    const text = [
      'eraTheWorld用の博麗の巫女、霊夢さんの口上です。',
      'プログラムとかの知識が全く無い作者がとりあえず勢いで作りました。',
      '作者は本口上が処女口上です。なけ無の語彙を絞りきって製作いたしました。',
    ].join('\n');
    expect(parseAttributionText('readme.txt', text).author).toBeNull();
  });

  it('无冒号的中文散文署名（「这里是国人作者破空」）宁缺勿滥 → 不猜，交给人看', () => {
    const text = '各位好啊，这里是国人作者破空（5419yf）';
    expect(parseAttributionText('readme.txt', text).author).toBeNull();
  });

  it('全角冒号 / 半角冒号 / 前导 ; 注释符都要能穿过去', () => {
    expect(parseAttributionText('r.txt', '; 作者：holy').author?.value).toBe('holy');
    expect(parseAttributionText('r.txt', 'Author: holy').author?.value).toBe('holy');
    expect(parseAttributionText('r.txt', '原作者：先代').author?.value).toBe('先代');
  });

  it('作者标签行后面跟整句说明时不吞长散文（>40 字符即拒）', () => {
    const long = '作者：' + '一'.repeat(41);
    expect(parseAttributionText('r.txt', long).author).toBeNull();
  });
});

describe('parseAttributionText · 更新与版本', () => {
  it('标签日期优先于裸日期（署名区惯例在头部）', () => {
    const text = ['2025-08-14　(※別作者) 一部を修正しました', '最終更新：2023-10-07'].join('\n');
    const r = parseAttributionText('readme.txt', text);
    expect(r.updated).toEqual({ value: '2023-10-07', file: 'readme.txt', line: 2 });
  });

  it('无标签时裸日期可用，且出处行号正确', () => {
    const r = parseAttributionText('readme.txt', '第一行\n2025/08/14　更新');
    expect(r.updated).toEqual({ value: '2025/08/14', file: 'readme.txt', line: 2 });
  });

  it('版本号三种真实写法（含逗号笔误 ver,0.03）都认；cover 不误命中', () => {
    expect(parseAttributionText('r.txt', 'eraTheWorld　桑尼米爾克口上 ver0.965').updated?.value).toBe('ver0.965');
    expect(parseAttributionText('r.txt', 'eraTheWorld　大妖精口上 ver.2.0').updated?.value).toBe('ver2.0');
    expect(parseAttributionText('r.txt', '魔理沙口上ver,0.03').updated?.value).toBe('ver0.03');
    expect(parseAttributionText('r.txt', 'this is a cover 3 thing').updated).toBeNull();
  });

  it('日期与版本同时存在时日期胜出（rank 靠前）', () => {
    const r = parseAttributionText('r.txt', '口上 ver1.2\n最終更新：2024-01-05');
    expect(r.updated?.value).toBe('2024-01-05');
  });
});

/* --------------------------- 包级编排（真实落盘） --------------------------- */

let tmpDir: string;
let pkgDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kojo-attr-'));
  pkgDir = path.join(tmpDir, '某作者口上');
  await fs.mkdir(pkgDir, { recursive: true });
});

async function put(name: string, content: string | Buffer): Promise<void> {
  await fs.writeFile(path.join(pkgDir, name), content);
}

describe('readPackageAttribution · 编排', () => {
  it('Shift-JIS README 也能抽出作者（编码探测在 io 层，本层不手工解码）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('readme.txt', iconv.encode('作者：holy\n最終更新：2023-10-07', 'shift_jis'));

    const a = await readPackageAttribution({ io, absDir: pkgDir });
    expect(a.author?.value).toBe('holy');
    expect(a.updated?.value).toBe('2023-10-07');
  });

  it('授权三态：真声明 > 仅模板 > 没有', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('ライセンステンプレ.txt', '（空模板）');
    expect((await readPackageAttribution({ io, absDir: pkgDir })).license).toEqual({
      kind: 'template-only',
      file: 'ライセンステンプレ.txt',
    });
    expect(licenseLabel((await readPackageAttribution({ io, absDir: pkgDir })).license)).toContain('仅授权模板');

    await put('ライセンス.txt', '加筆・改変は自由です');
    expect((await readPackageAttribution({ io, absDir: pkgDir })).license).toEqual({
      kind: 'statement',
      file: 'ライセンス.txt',
    });

    await fs.rm(path.join(pkgDir, 'ライセンス.txt'));
    await fs.rm(path.join(pkgDir, 'ライセンステンプレ.txt'));
    expect((await readPackageAttribution({ io, absDir: pkgDir })).license).toEqual({ kind: 'none' });
  });

  it('没抽到作者也如实呈现 readme 文件（提示用户自己去看，不假装没有）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('readme.txt', 'プログラムとかの知識が全く無い作者が作りました。');
    const a = await readPackageAttribution({ io, absDir: pkgDir });
    expect(a.author).toBeNull();
    expect(a.readmeFiles).toEqual(['readme.txt']);
    expect(attributionSummary(a)).toContain('原作者未标注');
  });

  it('单个附属文件读失败不影响整体（列举仍在、其余照抽）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('れあどめ.txt', '作者：holy');
    await put('更新履歴.txt', '2024-05-01 修正');
    const spy = {
      listDir: (p: string) => io.listDir(p),
      readText: async (p: string) => {
        if (p.endsWith('更新履歴.txt')) throw new Error('读不动');
        return io.readText(p);
      },
    };
    const a = await readPackageAttribution({ io: spy, absDir: pkgDir });
    expect(a.author?.value).toBe('holy');
    expect(a.readmeFiles).toHaveLength(2);
  });

  it('源目录一个字节都不被改动（只读链路）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('readme.txt', '作者：holy');
    const before = await fs.readFile(path.join(pkgDir, 'readme.txt'));
    await readPackageAttribution({ io, absDir: pkgDir });
    expect((await fs.readFile(path.join(pkgDir, 'readme.txt'))).equals(before)).toBe(true);
    expect((await fs.readdir(pkgDir)).sort()).toEqual(['readme.txt']);
  });

  it('摘要文案：抽到时拼三段', () => {
    const s = attributionSummary({
      author: { value: 'holy', file: 'readme.txt', line: 3 },
      updated: { value: '2023-10-07', file: 'readme.txt', line: 4 },
      license: { kind: 'statement', file: 'ライセンス.txt' },
      readmeFiles: ['readme.txt'],
    });
    expect(s).toBe('原作者 holy · 更新 2023-10-07 · 有授权声明文件（ライセンス.txt）');
  });
});

describe('attributionMeta · 导入携带', () => {
  const full: PackageAttribution = {
    author: { value: 'holy', file: 'readme.txt', line: 3 },
    updated: { value: '2023-10-07', file: 'readme.txt', line: 4 },
    license: { kind: 'statement', file: 'ライセンス.txt' },
    readmeFiles: ['readme.txt'],
  };

  it('抽到什么带什么；出处行号不进 meta（行号会随作者改 README 失效）', () => {
    expect(attributionMeta(full)).toEqual({
      originalAuthor: 'holy',
      originalUpdated: '2023-10-07',
      licenseKind: 'statement',
      licenseFile: 'ライセンス.txt',
    });
  });

  it('什么都没抽到 → 空对象（不写 null 占位污染 meta）', () => {
    expect(attributionMeta({ author: null, updated: null, license: { kind: 'none' }, readmeFiles: [] })).toEqual({});
    expect(attributionMeta(null)).toEqual({});
  });

  it('仅授权模板也如实记录 kind，不冒充真声明', () => {
    expect(
      attributionMeta({
        author: { value: 'holy', file: 'r.txt', line: 1 },
        updated: null,
        license: { kind: 'template-only', file: 'ライセンステンプレ.txt' },
        readmeFiles: ['r.txt'],
      }),
    ).toEqual({ originalAuthor: 'holy', licenseKind: 'template-only', licenseFile: 'ライセンステンプレ.txt' });
  });
});
