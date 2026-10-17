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
  mergePackAuthorship,
  packManifestPathOf,
  parseAttributionText,
  readPackageAttribution,
  readSourceAttribution,
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

/* --------------------------- 标题式候选署名（1018 反馈批） --------------------------- */

/**
 * 真实语料（`キャノボ風レティ` 的 readme.txt）：
 * ```
 * ※作者
 * 舩 弦五郎
 * ```
 * 作者与值不同行，冒号同行那条路抽不到。候选**只是候选**：必须用户在导入向导里
 * 勾选「采用此署名」才会落制品 meta，`author` 仍保持 null。
 */
describe('parseAttributionText · 标题式候选（作者标签独占一行）', () => {
  it('真实形态：※作者 下一行是名字 → authorCandidate 带文件/行号，author 仍为 null', () => {
    const text = ['キャノボ風レティ（eraTW用）', '', '※作者', '舩 弦五郎', '', '■更新履歴'].join('\n');
    const r = parseAttributionText('readme.txt', text);
    expect(r.author).toBeNull();
    expect(r.authorCandidate).toEqual({ value: '舩 弦五郎', file: 'readme.txt', line: 4 });
  });

  it('标签变体与前置装饰：作者 / 原作者 / 作成者 / Author / 尾随冒号都认；最多跳 2 行空行', () => {
    for (const label of ['作者', '※作者', '* 作者', '＊作者', '原作者', '作成者', 'Author', 'author:']) {
      const r = parseAttributionText('r.txt', `${label}\n\n\n舩 弦五郎`);
      expect(r.author, label).toBeNull();
      expect(r.authorCandidate?.value, label).toBe('舩 弦五郎');
      expect(r.authorCandidate?.line, label).toBe(4);
    }
  });

  it('标题后接散文（句号 / 问号 / 感叹号 / 超长）→ 无候选', () => {
    for (const value of [
      'この口上は私が作りました。',
      'これは誰ですか？',
      '本当にすごい！',
      'あ'.repeat(41),
    ]) {
      const r = parseAttributionText('r.txt', `※作者\n${value}`);
      expect(r.authorCandidate, value).toBeNull();
    }
  });

  it('含网址 / 尖括号残留 / 路径分隔符 → 无候选（不把整句或路径当人名）', () => {
    for (const value of ['https://example.com/foo', 'see www.example.com', '＜舩 弦五郎', 'foo\\bar', 'dir/name']) {
      const r = parseAttributionText('r.txt', `作者\n${value}`);
      expect(r.authorCandidate, value).toBeNull();
    }
  });

  it('模板占位说明词还在 → 无候选（未定 / 作者名・連絡先 / 请填写）', () => {
    for (const value of ['未定', '＜作者名・連絡先＞', '请填写你的名字']) {
      expect(parseAttributionText('r.txt', `作者\n${value}`).authorCandidate, value).toBeNull();
    }
  });

  it('下一行是另一个标签行或小标题 → 无候选（作者：… / 最终更新：… / 又一个标题 / ※連絡先 / ■…）', () => {
    for (const value of ['作者：hoge', '最終更新：2023-10-07', '※作者', '※連絡先', '■プロフィール']) {
      expect(parseAttributionText('r.txt', `作者\n${value}`).authorCandidate, value).toBeNull();
    }
  });

  it('空行超过 2 行 / 标签在文件末尾 → 无候选（不往正文深处乱扫）', () => {
    expect(parseAttributionText('r.txt', '作者\n\n\n\n舩 弦五郎').authorCandidate).toBeNull();
    expect(parseAttributionText('r.txt', '标题\n※作者').authorCandidate).toBeNull();
  });

  it('同一文件里冒号同行的高置信 author 仍优先，标题式候选不露面', () => {
    const r = parseAttributionText('readme.txt', ['※作者', '舩 弦五郎', '作者：holy'].join('\n'));
    expect(r.author).toEqual({ value: 'holy', file: 'readme.txt', line: 3 });
    expect(r.authorCandidate).toBeNull();
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

/* ---------------------- 许可证模板里的候选署名（模板 ≠ 授权声明） ---------------------- */

describe('readPackageAttribution · 许可证模板作者候选', () => {
  it('模板里作者真填了（说明已删）→ 候选带出处；license 仍报 template-only', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('ライセンステンプレ.txt', ['; ライセンス', '; 作者：＜舩 弦五郎＞', ';'].join('\n'));
    const a = await readPackageAttribution({ io, absDir: pkgDir });
    expect(a.author).toBeNull();
    expect(a.authorCandidate).toEqual({ value: '舩 弦五郎', file: 'ライセンステンプレ.txt', line: 2 });
    // 模板仍不是授权声明（规则 3 不动）
    expect(a.license).toEqual({ kind: 'template-only', file: 'ライセンステンプレ.txt' });
  });

  it('模板占位说明还在（根本没填过）→ 无候选，license 仍 template-only', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put(
      'ライセンステンプレ.txt',
      '作者：＜作者名・連絡先＞（“XXスレ目>>123” 等でもOKなので、何か他人と被らないものを）',
    );
    const a = await readPackageAttribution({ io, absDir: pkgDir });
    expect(a.authorCandidate).toBeNull();
    expect(a.license.kind).toBe('template-only');
  });

  it('README 标题式候选优先于模板候选（不混成两个证据）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('readme.txt', ['※作者', '舩 弦五郎'].join('\n'));
    await put('ライセンステンプレ.txt', '作者：＜另一个人＞');
    const a = await readPackageAttribution({ io, absDir: pkgDir });
    expect(a.authorCandidate).toEqual({ value: '舩 弦五郎', file: 'readme.txt', line: 2 });
  });

  it('README 已有高置信 author → 模板候选不出现（候选只服务未标注）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('readme.txt', '作者：holy');
    await put('ライセンステンプレ.txt', '作者：＜舩 弦五郎＞');
    const a = await readPackageAttribution({ io, absDir: pkgDir });
    expect(a.author?.value).toBe('holy');
    expect(a.authorCandidate).toBeNull();
  });

  it('市场清单补出 author 时，README 候选作废（声明优先于候选）', async () => {
    const io = new FileIOServiceImpl(new NodeBridge(path.join(tmpDir, 'appdata')));
    await put('readme.txt', ['※作者', '舩 弦五郎'].join('\n'));
    const base = await readPackageAttribution({ io, absDir: pkgDir });
    expect(base.authorCandidate?.value).toBe('舩 弦五郎');
    const merged = mergePackAuthorship(base, { author: '清单作者', license: '', authorLine: 2 });
    expect(merged.author?.value).toBe('清单作者');
    expect(merged.authorCandidate).toBeNull();
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

/* ------------------- 市场来源署名兜底（KM-13：pack.json 在源目录上一级） ------------------- */

/**
 * 市场包的正文（`files/`）通常没有 README，署名只住在上一级 `pack.json`——
 * 从市场导入这些包时，"原作者是谁"只有清单这一条线索。四条判据：
 * 1. 市场来源：README 抽不到的字段才用清单兜底（清单是兜底，不覆盖 README）；
 * 2. 非市场来源：**不读上一级**（普通目录的上一级可能是家里另一个包的清单，读到就是冒认署名）；
 * 3. 读不到 / 解析不出：回退 README 画像，绝不抛（署名缺失不允许阻断导入）；
 * 4. 出处照 `AttributionField` / `LicenseSignal` 既有形状，不新增类型。
 */
describe('readSourceAttribution · 市场来源 pack.json 兜底（KM-13）', () => {
  const PACK_DIR = '/appdata/market/packs/kojo-pack/demo.kojo/1.0.0/files';
  const MANIFEST = '/appdata/market/packs/kojo-pack/demo.kojo/1.0.0/pack.json';

  /** 内存树 io（只列本层文件；readText 记录读过的路径，用来钉"没读上一级"） */
  const treeIo = (tree: Record<string, string>, reads?: string[]) => ({
    listDir: async (dir: string): Promise<Array<{ name: string; path: string; isDirectory: boolean }>> =>
      Object.keys(tree)
        .filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => ({ name: p.slice(dir.length + 1), path: p, isDirectory: false })),
    readText: async (p: string): Promise<{ text: string }> => {
      reads?.push(p);
      const t = tree[p];
      if (t === undefined) throw new Error(`没有这个文件：${p}`);
      return { text: t };
    },
  });

  it('清单落点 = contentDir 上一级 pack.json（唯一派生，不自己拼第二份目录约定）', () => {
    expect(packManifestPathOf(PACK_DIR)).toBe(MANIFEST);
  });

  it('README 侧什么都没抽到：清单声明的 author / license 兜底出来，出处记为 pack.json', async () => {
    const io = treeIo({
      [`${PACK_DIR}/口上.ERB`]: '@SAY こんにちは',
      [MANIFEST]: JSON.stringify({ kind: 'kojo-pack', author: '原作者的群友', license: 'CC BY-NC-SA 4.0' }),
    });
    const a = await readSourceAttribution({ io, absDir: PACK_DIR, source: 'market' });
    expect(a.author).toEqual({ value: '原作者的群友', file: 'pack.json', line: 1 });
    expect(a.license).toEqual({ kind: 'statement', file: 'pack.json' });
    // 既有 meta 链路自动受益：导入时带走的就是这两个字段
    expect(attributionMeta(a)).toEqual({
      originalAuthor: '原作者的群友',
      licenseKind: 'statement',
      licenseFile: 'pack.json',
    });
    // 摘要里看得见署名（面板/向导同一口径）
    expect(attributionSummary(a)).toContain('原作者 原作者的群友');
  });

  it('README 抽到了作者：README 优先（带自己那份出处），清单只补它没有的授权那半', async () => {
    const io = treeIo({
      [`${PACK_DIR}/readme.txt`]: '作者：holy',
      [MANIFEST]: JSON.stringify({ author: '另一个人', license: 'MIT' }),
    });
    const a = await readSourceAttribution({ io, absDir: PACK_DIR, source: 'market' });
    expect(a.author).toEqual({ value: 'holy', file: 'readme.txt', line: 1 });
    expect(a.license).toEqual({ kind: 'statement', file: 'pack.json' });
  });

  it('README 侧有真授权文件：清单不覆盖（包内那份文件比清单一行更具体）', async () => {
    const io = treeIo({
      [`${PACK_DIR}/readme.txt`]: '作者：holy',
      [`${PACK_DIR}/ライセンス.txt`]: '加筆・改変は自由です',
      [MANIFEST]: JSON.stringify({ author: '另一个人', license: 'MIT' }),
    });
    const base = await readPackageAttribution({ io, absDir: PACK_DIR });
    const a = await readSourceAttribution({ io, absDir: PACK_DIR, source: 'market' });
    expect(a.author?.value).toBe('holy');
    expect(a.license).toEqual({ kind: 'statement', file: 'ライセンス.txt' });
    // 与不开兜底时的画像逐字一致（没有可补的字段 ⇒ 原样）
    expect(a).toEqual(base);
  });

  it('非市场来源：连上一级 pack.json 都不读（那里可能是别家包的清单，读到就是冒认署名）', async () => {
    const reads: string[] = [];
    const io = treeIo(
      {
        [`${PACK_DIR}/readme.txt`]: '正文里没有署名标签',
        [MANIFEST]: JSON.stringify({ author: '不该出现的人' }),
      },
      reads,
    );
    const a = await readSourceAttribution({ io, absDir: PACK_DIR }); // 无 source = 普通目录导入
    expect(a.author).toBeNull();
    expect(a.license).toEqual({ kind: 'none' });
    expect(reads.some((p) => p.endsWith('pack.json'))).toBe(false);
  });

  it('清单读不到 / 坏 JSON：回退 README 画像，不抛（署名缺失绝不阻断导入）', async () => {
    const noManifest = treeIo({ [`${PACK_DIR}/readme.txt`]: '作者：holy' });
    const a = await readSourceAttribution({ io: noManifest, absDir: PACK_DIR, source: 'market' });
    expect(a.author?.value).toBe('holy');
    expect(a.license).toEqual({ kind: 'none' });

    const badJson = treeIo({
      [`${PACK_DIR}/readme.txt`]: '作者：holy',
      [MANIFEST]: '{ not json',
    });
    const b = await readSourceAttribution({ io: badJson, absDir: PACK_DIR, source: 'market' });
    expect(b.author?.value).toBe('holy');
    expect(b.license).toEqual({ kind: 'none' });
  });

  it('多行清单：出处行号 = "author" 首次出现的那一行（给证据，不给结论）', async () => {
    const manifest = [
      '{',
      '  "kind": "kojo-pack",',
      '  "author": "某人",',
      '  "license": "MIT"',
      '}',
    ].join('\n');
    const io = treeIo({ [`${PACK_DIR}/口上.ERB`]: '@SAY こんにちは', [MANIFEST]: manifest });
    const a = await readSourceAttribution({ io, absDir: PACK_DIR, source: 'market' });
    expect(a.author).toEqual({ value: '某人', file: 'pack.json', line: 3 });
  });

  it('mergePackAuthorship：没有可补的字段时原样返回 base（引用相等，调用方据此可判"没改过"）', () => {
    const complete: PackageAttribution = {
      author: { value: 'holy', file: 'readme.txt', line: 3 },
      updated: { value: '2023-10-07', file: 'readme.txt', line: 4 },
      license: { kind: 'statement', file: 'ライセンス.txt' },
      readmeFiles: ['readme.txt'],
    };
    expect(mergePackAuthorship(complete, null)).toBe(complete);
    expect(mergePackAuthorship(complete, { author: '', license: '', authorLine: 1 })).toBe(complete);
    expect(mergePackAuthorship(complete, { author: '别人', license: 'MIT', authorLine: 2 })).toBe(complete);
  });
});
