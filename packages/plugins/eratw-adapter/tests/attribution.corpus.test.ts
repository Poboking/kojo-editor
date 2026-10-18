/**
 * 署名 / 授权抽取 —— 真实语料基线（KOJO_SMOKE_PROJECT 守门，无游戏目录自动跳过）。
 *
 * 与 `call-slot-coverage.corpus.test.ts` 同一性质：**把解析器在真实语料上的实测结果
 * 固化为回归基线**。单测只能证明"我想到的形态能处理"，这一份证明的是
 * "国内作者实际写出来的东西，精度到底有多少"——T2 这种**宁缺勿滥**的抽取器，
 * 最怕的不是漏抽，而是**假阳性悄悄涨回来**（把模板占位当人名报给用户）。
 *
 * 基线来源：2026-10-12 实测本机 eraTW 4.980 基线语料
 * 的 `ERB/口上・メッセージ関連/個人口上`（155 角色目录）。
 * 若此基线变动：要么语料更换，要么抽取语义发生回归——两者都需人工确认。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { readPackageAttribution } from '@kojo/kojo-project-kit';

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

/** 找出「作者包」目录：角色目录下 1 层子目录（无子目录的角色 = ERB 直接堆着，属反例不计） */
function packageDirs(root: string): string[] {
  const out: string[] = [];
  for (const chara of readdirSync(root, { withFileTypes: true })) {
    if (!chara.isDirectory()) continue;
    const charaPath = join(root, chara.name);
    let children: Dirent[];
    try {
      children = readdirSync(charaPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const sub = children.filter((e) => e.isDirectory());
    if (sub.length > 0) out.push(...sub.map((e) => join(charaPath, e.name)));
    else out.push(charaPath); // 无包目录、直接堆 ERB 的角色（纪要 §1 反例：159 先代）
  }
  return out;
}

describe.skipIf(!SMOKE)('署名抽取 · 真实语料基线', () => {
  it('155 角色目录下的作者包抽取率与零假阳性形态（逐字基线）', async () => {
    const kojoRoot = join(SMOKE!, 'ERB', '口上・メッセージ関連', '個人口上');
    let dirs: string[];
    try {
      statSync(kojoRoot);
      dirs = packageDirs(kojoRoot);
    } catch {
      // 语料在但结构不符预期：显式失败，不静默跳过
      throw new Error(`语料口上根不存在：${kojoRoot}`);
    }

    const io = new FileIOServiceImpl(new NodeBridge(join(SMOKE!, '..')));
    let withReadme = 0;
    let withAuthor = 0;
    let withUpdated = 0;
    let withLicenseStatement = 0;
    let templateOnly = 0;
    const authors: string[] = [];

    for (const dir of dirs) {
      const a = await readPackageAttribution({ io, absDir: dir });
      if (a.readmeFiles.length > 0) withReadme++;
      if (a.author) {
        withAuthor++;
        authors.push(a.author.value);
      }
      if (a.updated) withUpdated++;
      if (a.license.kind === 'statement') withLicenseStatement++;
      if (a.license.kind === 'template-only') templateOnly++;
    }

    // ---- 形态基线（2026-10-12 实测，非引用他人结论）----
    expect(dirs.length).toBeGreaterThanOrEqual(210);
    // readme / 更新历史类覆盖 **149/214 = 69.6%**。
    // ⚠ 与纪要 §1 声称的「85.5% 的包含 README 类文档」**对不上**：本语料有 16 个包
    // 根本没有任何附属文件（理论上限 92.5%），另有约 49 个包只有授权文件或 HOGE 占位或杂记。
    // 纪要那个数应是更宽口径（把授权/杂记也算"文档"）或不同粒度所得——**保留实测值，
    // 不为凑那个数放宽分类**。阈值留 4 个百分点余量防小幅抖动。
    expect(withReadme / dirs.length).toBeGreaterThan(0.65);
    // 授权文件形态：**真声明 54 包 vs 仅空模板 64 包**——过半"授权文件"是作者没填的模板。
    // 这正是本模块把 template-only 与 statement 分开计的理由：混为一谈会让
    // "已标注授权"从实测 25% 虚高到 55%，等于替作者做出他没做过的声明。
    expect(withLicenseStatement).toBeGreaterThan(40);
    expect(templateOnly).toBeGreaterThan(withLicenseStatement);
    expect(withAuthor).toBeGreaterThan(0); // 至少能抽到真署名（当前实测个位数——标签写法本就稀少）

    // 假阳性防线：抽出来的"作者"里绝不能出现模板占位特征
    // （判据独立于实现的词表——含 >>回帖号 / XX条目 / 等也OK 这类语言无关指纹，
    //   汉化版模板的说明括注也在这儿被拦住，实现曾漏过它并被本断言逮住）
    const placeholderish = authors.filter((v) =>
      /^[<＜(（[]|作者名|連絡先|名前・|your\s*name|>>\s*\d{2,}|XXスレ|XX条目|等でも ?OK|等也 ?OK|相重合/i.test(v),
    );
    expect(placeholderish, `假阳性作者：${placeholderish.join(' | ')}`).toEqual([]);

    // eslint-disable-next-line no-console
    console.log(
      `[T2 语料基线] 包 ${dirs.length} · 有 readme ${withReadme} · 抽到作者 ${withAuthor} · ` +
        `抽到更新/版本 ${withUpdated} · 授权真声明 ${withLicenseStatement} · 仅模板 ${templateOnly}\n` +
        `  作者样本：${authors.slice(0, 12).join(' / ')}`,
    );
  }, 180_000);
});
