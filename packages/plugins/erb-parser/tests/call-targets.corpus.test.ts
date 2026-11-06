/**
 * 未定义 CALL 目标 · 真实语料精度闸（ERBDIAG-B / D03 批②，`KOJO_SMOKE_PROJECT` 守门）。
 *
 * 钉死三件事（`structure.corpus.test.ts` 的同一条纪律：**波浪线不许说谎**）：
 * 1. **零误报**：全语料 `scanUndefinedCallTargets`（生产判据、生产解码路径）命中 **必须 0 条**。
 *    改前的实测基线是 **23 条**，逐条分类如下（都是我们判错，不是作者写错，故**一条都不保留**）：
 *    - **21 条 TRY 系直系调用**（`TRYCALL` / `TRYCCALL` 系）——引擎按名调用那一步
 *      （Emuera `Instraction.Child.cs`）写的是
 *      `if ((call == null) && (!func.Function.IsTry())) FunctionoNotFoundName = …`
 *      ⇒ TRY 系找不到函数**是引擎允许的行为**（可选钩子：装了才存在、没装什么也不做），
 *      静态层报它就是拿"引擎不吃这一套"当缺陷吓作者；
 *    - **2 条 `CALL` 槽被我们的记号尺切断**（形如 `…立位＆時間停止＆抜かず`）——引擎读名字是
 *      `ArgumentBuilder.cs` 的 `ReadString(st, StrEndWith.LeftParenthesis_Bracket_Comma_Semicolon)`
 *      + `Trim([' ', '\t'])`，名字只在 `(` / `[` / `,` / `;` / 行尾断开；全角 `＆` 不是分隔符，
 *      而那个**全名在盘上真实存在**（`@` 定义行可查）⇒ 我们只拿到半截去查名录。
 * 2. **判据确实在工作**（不是"整条链没跑起来"造成的 0）：同一趟里用 `includeTry` 那扇门复算，
 *    TRY 档必须仍数得出**十几条**可选钩子缺失（实测 14 条，改前那一臂是 21 条），并且
 *    `TRYCALL CustomTraits(ARG)` 这类"引擎也在此断开"的形态要回来、
 *    `TRYCALL M_KOJO_COLOR_K[[色名]]` 这类子名形态**连信息档也不许有**；再逐条钉
 *    `ERB/COMMON.ERB:3369` 那一行原样（默认档不报 / 信息档报），以及那两条被切断的
 *    `CALL …立位＆時間停止＆…` 的**全名确实能在名录里查到**（⇒ 误报责任在我们，不在作者）。
 * 3. **名录规模自证**：`@` 定义名集合的规模与非 ASCII 占比打印出来做分母，
 *    并把改前 23 条涉及的三个名字逐个查名录 ⇒ 必须"确实不在名录里"
 *    （证明那 23 条不是名录没建起来造成的空集假象）。
 *
 * 反证（会红的方向）写在最后一节：`CALL X` 报 / 改成 `TRYCALL X` 不报 / 动态子名不报 ——
 * 三条都在**合成小盘**上钉，这样语料暂离时判据依然有兜底。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isErbDialectPath } from '@kojo/plugin-api';
import { FileIOServiceImpl } from '../../../kernel/src/io';
import { NodeBridge } from '../../../kernel/tests/helpers/node-bridge';
import { parseErbText } from '../src/scanner';
import { scanUndefinedCallTargets, type UndefinedCallTarget } from '../src/references';

const SMOKE = process.env.KOJO_SMOKE_PROJECT;

function erbFilesUnder(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) erbFilesUnder(p, out);
    else if (isErbDialectPath(e.name)) out.push(p);
  }
}

describe.skipIf(!SMOKE)('未定义 CALL 目标 · 真实语料零误报（D03）', () => {
  it('全语料 scanUndefinedCallTargets 命中 0 条，且判据确实在工作', async () => {
    const root = join(SMOKE!, 'ERB');
    statSync(root);
    const files: string[] = [];
    erbFilesUnder(root, files);
    expect(files.length, '语料 ERB 文件数').toBeGreaterThan(3000);

    const io = new FileIOServiceImpl(new NodeBridge(SMOKE!));

    // 第一遍：只收名录（`@` 定义名，大写归一——与生产 `aggregateIndex` 的 byName 键同一条口径）
    const names = new Set<string>();
    let lines = 0;
    let nonAscii = 0;
    for (const f of files) {
      const tf = await io.readText(f);
      lines += tf.text.split('\n').length;
      for (const fn of parseErbText(tf.text, f).functions) {
        const upper = fn.name.toUpperCase();
        if (!names.has(upper)) {
          names.add(upper);
          if (/[^\x20-\x7e]/.test(upper)) nonAscii++;
        }
      }
    }
    const hasName = (upper: string): boolean => names.has(upper);
    expect(names.size, '名录规模').toBeGreaterThan(50000);

    // 第二遍：生产判据
    const hits: string[] = [];
    const tryHits: string[] = [];
    for (const f of files) {
      const tf = await io.readText(f);
      const rel = f.replace(SMOKE!, '');
      for (const t of scanUndefinedCallTargets(tf.text, hasName))
        hits.push(`${rel}:${t.line}:${t.column} ${t.name}`);
      for (const t of scanUndefinedCallTargets(tf.text, hasName, { includeTry: true }))
        if (t.isTry === true) tryHits.push(`${rel}:${t.line} ${t.name}`);
    }

    console.log(
      `语料 ${files.length} 文件 / ${lines} 行；名录 ${names.size} 枚（非 ASCII ${nonAscii}）；` +
        `默认档命中 ${hits.length}；TRY 信息档（includeTry）命中 ${tryHits.length}`,
    );

    // ①零误报（改前 23 条：21 条 TRY 系 + 2 条记号尺切断）
    expect(hits, `误报清单（应为空）：\n${hits.slice(0, 40).join('\n')}`).toEqual([]);

    // ②判据在工作（改前 23 条的分解在这里逐臂复算，不是"整条链没跑"造成的 0）：
    //   - 默认档 0 条（①已钉）；
    //   - `includeTry` 信息档 **14** 条 = 21 条 TRY 系未收录目标里"槽位收尾处引擎也断开"的那些
    //     （另 7 条是 `TRYCALL M_KOJO_COLOR_K[[色名]]` 形态，被子名档挡下 ⇒ 连信息档也不该有）；
    //   - 改前那 21 条 TRY 命中在这里全部回来（gate 只影响默认档的展示，不影响判据覆盖面）。
    expect(tryHits.length, `TRY 信息档命中（实测 14）：\n${tryHits.slice(0, 30).join('\n')}`).toBeGreaterThanOrEqual(
      14,
    );
    expect(tryHits.filter((h) => h.includes(' CustomTraits')).length, 'TRYCALL CustomTraits 应在信息档里').toBe(1);
    expect(tryHits.filter((h) => h.includes(' M_KOJO_COLOR_K')).length, '子名形态连信息档也不报').toBe(0);

    // ③改前那 23 条涉及的名字确实不在名录里（不是"名录空集"造成的假零）
    for (const probe of ['CUSTOMTRAITS', 'SET_KOJOCOLOR', 'M_KOJO_COLOR_K'])
      expect(hasName(probe), `名录探针 ${probe} 应缺席（改前正是因此报出）`).toBe(false);

    // ③b 反向：那两条被记号尺切断的 `CALL`，**全名**在名录里真实存在 ⇒ 误报是我们的尺造成的，
    //     不是作者写错（所以一条都不保留）
    for (const full of ['MESSAGE_COM61背面立位＆時間停止＆抜かず', 'MESSAGE_COM61背面立位＆時間停止＆新規挿入'])
      expect(hasName(full.toUpperCase()), `名录里应查得到全名 ${full}`).toBe(true);
    // ④两处真实形状逐条钉（行号取自语料，只读；命中判据两侧都过一遍）
    const common = join(root, 'COMMON.ERB');
    const commonText = (await io.readText(common)).text;
    const line3369 = commonText.split('\n')[3368] ?? '';
    expect(line3369.trimStart().slice(0, 30), 'ERB/COMMON.ERB:3369 原样').toMatch(/^TRYCALL CustomTraits/);
    expect(scanUndefinedCallTargets(line3369, hasName)).toEqual([]);
    expect(scanUndefinedCallTargets(line3369, hasName, { includeTry: true })).toEqual([
      { line: 1, column: 9, name: 'CustomTraits', isTry: true },
    ]);

    // 全角 ＆ 那条：那个带 ＆ 的**全名**在盘上真实存在（否则"切断"就不是我们的错）
    const ampNamed = [...names].filter((n) => n.includes('＆'));
    expect(ampNamed.length, '语料里带全角 ＆ 的 @ 定义名数量').toBeGreaterThan(0);
  }, 300000);
});

/* ---------------------------------------------------------------------------
 * 反证（合成小盘，语料暂离也照样红）：`CALL X` 报 / `TRYCALL X` 不报 / 子名不报
 * ------------------------------------------------------------------------- */
describe('反证 · TRY 分层与子名档在合成盘上翻转', () => {
  const dict = (ns: readonly string[]) => {
    const s = new Set(ns.map((n) => n.toUpperCase()));
    return (upper: string) => s.has(upper);
  };
  const empty = dict([]);
  const bare = (t: string): readonly UndefinedCallTarget[] => scanUndefinedCallTargets(t, empty);

  it('同一行只把关键字换成 TRYCALL ⇒ 默认档从报变不报（TRY 系目标缺失引擎允许）', () => {
    expect(bare('CALL MISSING\n')).toEqual([{ line: 1, column: 6, name: 'MISSING' }]);
    expect(bare('TRYCALL MISSING\n')).toEqual([]);
    // 反证的反证：信息档显式开才回来 ⇒ warning 面没被稀释
    expect(scanUndefinedCallTargets('TRYCALL MISSING\n', empty, { includeTry: true })).toEqual([
      { line: 1, column: 9, name: 'MISSING', isTry: true },
    ]);
  });

  it('名字后紧跟 [ / [[ 的子名形态不判；换成 ( 分隔符照判（引擎 ReadString 的分隔符全集）', () => {
    expect(bare('CALL MISSING[[莉莉白]]\n')).toEqual([]);
    expect(bare('CALL MISSING[SUB]\n')).toEqual([]);
    expect(bare('CALL MISSING(SUB)\n')).toEqual([{ line: 1, column: 6, name: 'MISSING' }]);
  });

  it('记号尺比引擎窄时不判：全角 ＆ 续接的名字不作静态判定（那个全名在盘上可能存在）', () => {
    expect(bare('CALL 立位＆時間停止\n')).toEqual([]);
    // 名录里有**整串**时同样不报（两个方向都不误报）
    expect(scanUndefinedCallTargets('CALL 立位＆時間停止\n', dict(['立位＆時間停止']))).toEqual([]);
  });
});
