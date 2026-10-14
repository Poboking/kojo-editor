import { describe, expect, it } from 'vitest';
import type { FileIO, Logger } from '@kojo/plugin-api';
import { loadEratwVariableSchema, mergeVariableTable, parseChsMap, parseVariableCsv } from '../src/variable-schema';

describe('parseVariableCsv', () => {
  it('基础解析：编号,名称', () => {
    const t = parseVariableCsv(['1,既成事実', '2,好感度', '4,信頼度'].join('\n'));
    expect(t.byIndex.get('2')).toBe('好感度');
    expect(t.byName.get('信頼度')).toBe('4');
  });

  it('注释行 / 空行 / 非数字行跳过', () => {
    const t = parseVariableCsv([';标题注释', '', '  ;缩进注释', '2,好感度', 'abc,非法', ',无名'].join('\n'));
    expect(t.byIndex.size).toBe(1);
    expect(t.byIndex.get('2')).toBe('好感度');
  });

  it('第三列注释不进入名称', () => {
    const t = parseVariableCsv('3,恋慕,;愛情に似た感情を抱いている状態。=2で上位互換');
    expect(t.byIndex.get('3')).toBe('恋慕');
  });

  it('tab 缩进的续行注释跳过（Talent.csv 真实形态）', () => {
    const text = ['10,胆量,', '\t; -1=膽怯,;ABL:従順が上げやすい', '11,態度,'].join('\n');
    const t = parseVariableCsv(text);
    expect(t.byIndex.get('10')).toBe('胆量');
    expect(t.byIndex.get('11')).toBe('態度');
    expect(t.byIndex.size).toBe(2);
  });

  it('同编号/名称首个定义优先', () => {
    const t = parseVariableCsv(['2,好感度', '2,重复'].join('\n'));
    expect(t.byIndex.get('2')).toBe('好感度');
  });
});

describe('parseChsMap', () => {
  it('解析 <p><k><v> 词典；空键跳过、同名取首条、容忍 BOM', () => {
    const m = parseChsMap(
      '\uFEFF<map><p><k>好感度</k><v>好感度</v></p><p><k></k><v>x</v></p>' +
        '<p><k>信頼度</k><v>信赖度</v></p><p><k>信頼度</k><v>重复</v></p></map>',
    );
    expect(m.get('信頼度')).toBe('信赖度');
    expect(m.get('好感度')).toBe('好感度');
    expect(m.size).toBe(2);
  });

  it('无 <p><k><v> 形态 → 空 Map（不抛）', () => {
    expect(parseChsMap('<map></map>').size).toBe(0);
  });
});

describe('loadEratwVariableSchema', () => {
  const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  function fakeIo(files: Record<string, string>): FileIO {
    return {
      listDir: async (dir: string) => {
        void dir;
        const entries = Object.keys(files)
          .filter((name) => !name.includes('/'))
          .map((name) => ({
            name,
            path: `/game/CSV/${name}`,
            isDirectory: false,
          }));
        entries.push({ name: 'Chara', path: '/game/CSV/Chara', isDirectory: true });
        return entries;
      },
      readText: async (path: string) => ({
        text: files[path] ?? files[path.replace('/game/CSV/', '')] ?? '',
        path,
      }),
    } as unknown as FileIO;
  }

  it('扫描目录、按文件名大写建表、lookup 双向可用', async () => {    const schema = await loadEratwVariableSchema({
      io: fakeIo({
        'CFLAG.csv': '2,好感度\n4,信頼度\n',
        'Talent.csv': '3,恋慕\n',
      }),
      csvDir: '/game/CSV',
      log: silentLog,
    });

    expect(schema.lookup('CFLAG', 2)).toEqual({ name: 'CFLAG', index: 2, description: '好感度', resolvedIndex: 2 });
    expect(schema.lookup('cflag', '2')).toEqual({ name: 'CFLAG', index: '2', description: '好感度', resolvedIndex: 2 });
    expect(schema.lookup('TALENT', '恋慕')).toEqual({ name: 'TALENT', index: '恋慕', description: '恋慕', resolvedIndex: 3 });
    // 家族级（无索引）：游戏无机读族名表 → 取适配器内置策展常量
    expect(schema.lookup('CFLAG')).toEqual({ name: 'CFLAG', description: '角色标志' });
    expect(schema.lookup('CFLAG', 999)).toEqual({ name: 'CFLAG', index: 999 });
    expect(schema.lookup('NOPE', 1)).toBeUndefined();
  });

  it('汉化词典叠加：索引级名称 JP→CN（查不到回落原文）', async () => {
    const schema = await loadEratwVariableSchema({
      io: fakeIo({
        'CFLAG.csv': '2,好感度\n4,信頼度\n',
        '/game/plugins/tw_csv_chs.xml':
          '<map><p><k>信頼度</k><v>信赖度</v></p><p><k>恋慕</k><v>恋慕</v></p></map>',
      }),
      csvDir: '/game/CSV',
      chsMapPath: '/game/plugins/tw_csv_chs.xml',
      log: silentLog,
    });
    // 词典命中 → 中文
    expect(schema.lookup('CFLAG', 4)).toEqual({ name: 'CFLAG', index: 4, description: '信赖度', resolvedIndex: 4 });
    // 词典未收录 → 回落名称表原文
    expect(schema.lookup('CFLAG', 2)?.description).toBe('好感度');
  });

  it('目录不可读时返回空字典（不抛错）', async () => {
    const badIo = {
      listDir: async () => {
        throw new Error('boom');
      },
      readText: async () => ({ text: '' }),
    } as unknown as FileIO;
    const schema = await loadEratwVariableSchema({ io: badIo, csvDir: '/game/CSV', log: silentLog });
    expect(schema.lookup('CFLAG', 2)).toBeUndefined();
  });

  it('inputDigest：同输入稳定、改描述即变、与目录顺序无关', async () => {
    // 抽取结果里存着 schema 给的语义标签；变量字典由 CSV 驱动 ⇒ 判据必须含它，
    // 否则改了 `CFLAG.csv` 一行描述，派生缓存还会吐旧标签。
    const load = (files: Record<string, string>) =>
      loadEratwVariableSchema({ io: fakeIo(files), csvDir: '/game/CSV', log: silentLog });
    const set = { 'CFLAG.csv': '2,好感度\n', 'Talent.csv': '3,恋慕\n' };

    const a = await load(set);
    const b = await load({ 'Talent.csv': set['Talent.csv']!, 'CFLAG.csv': set['CFLAG.csv']! });
    const changed = await load({ 'CFLAG.csv': '2,心情\n', 'Talent.csv': '3,恋慕\n' });
    const extra = await load({ 'CFLAG.csv': set['CFLAG.csv']!, 'Talent.csv': '3,恋慕\n', 'Abl.csv': '1,身体\n' });

    expect(typeof a.inputDigest).toBe('string');
    expect(a.inputDigest).toBe(b.inputDigest);
    expect(changed.inputDigest).not.toBe(a.inputDigest);
    expect(extra.inputDigest).not.toBe(a.inputDigest);
    // 一张都读不到时也是确定值（区别于 undefined = "没有判据"）
    const none = await load({});
    expect(typeof none.inputDigest).toBe('string');
    expect(none.inputDigest).not.toBe(a.inputDigest);
  });
});

/* ========================= CSV/*.als 追加名表（ALS 批 2026-10-14） =========================
 *
 * 病根（P-10③ 留的前置）：字典只扫 `CSV/*.csv` ⇒ 汉化/魔改放在 `CSV/*.als` 里的**别名**
 * 天然查无，`族头:具名` 核对因此只能停在 4 个族。
 *
 * 逐份实测 19 份 `.als`（画蛇添足版 4.980）后钉住的事实：
 * - **行格式与 `.csv` 同一套**（`编号,名称[,备注]` / `;` 注释 / 空行 / tab 缩进的续行注释），
 *   非数字行首 0 例、无逗号分组标题 0 例 ⇒ 复用同一个解析器，不另写一套；
 * - **BOM 不保证**：画蛇添足版 19/19 带 UTF-8 BOM，魔王改版有 3 份（FLAG/Item/Talent）**不带**；
 * - **换行一律 LF**（两版 39 份 `.als` 里 0 个 CRLF），8/19 无尾换行 ⇒ 末行必须照收；
 * - `.als` 的"备注"常常**粘在名称列里**（`DAY.als:3` = `2,季節;（1=春 2=夏 3=秋 4=冬）`，
 *   而 `DAY.csv:3` 是 `2,季節,;（1=春 …）` 把注释放第三列）⇒ 名称段会带出 `;（…）` 尾巴；
 * - 同一份 `.als` 内部会**同编号写两个名字**（`Base.als:10-11` = `10,情绪` + `10,情緒` 简繁双写）。
 *
 * 合并口径 = **主表优先、只并集不覆盖**（先全部 `.csv` 后全部 `.als`，沿用同一条"首个定义优先"）：
 * 实测该口径下 `byIndex` 对主表已定义的编号**逐字不变**（19 份表共只补 26 个主表缺的编号），
 * 变化全部发生在 `byName`（+757 个别名）。真实冲突例：`TCVAR.csv:83 = 145,烂醉` vs
 * `TCVAR.als:76 = 145,泥酔`；`Abl.csv:9 = 9,親密` vs `Abl.als:9 = 9,亲密`；`ex.csv:2 = 1,Ｖ絶頂`
 * vs `ex.als:2 = 1,Ｖ绝顶`。同名字跨编号相撞：两版实测 **0 例**（规则仍钉死 = 主表胜出）。
 * 游戏自带工具 `tool/Generate_ERH.py` 也是"先 CSV 后 ALS、撞名保留旧值"⇒ 本并不另立标准。
 * ========================================================================================== */

describe('mergeVariableTable：追加名表并入 = 只并集、不覆盖', () => {
  it('并入 `.als` 后主表编号的名称一字不改，追加名进反向表', () => {
    const table = parseVariableCsv('9,親密\n'); // Abl.csv:9 原文
    const merged = mergeVariableTable(table, '9,亲密\n'); // Abl.als:9 原文（简繁同编号双写）
    expect(table.byIndex.get('9')).toBe('親密'); // **没有被改成 亲密**
    expect(table.byName.get('亲密')).toBe('9');
    expect(table.byName.get('親密')).toBe('9');
    expect(merged).toEqual({ addedIndex: 0, addedName: 1 });
  });

  it('`.als` 独有的编号补得进（Item.csv:7 是 `;6,後庭拉珠` 注释掉的，Item.als:7 把它写活了）', () => {
    const table = parseVariableCsv('5,肛用振動棒,4500,\n;6,後庭拉珠,4500,\n');
    const merged = mergeVariableTable(table, '6,アナルビーズ,4500,\n');
    expect(table.byIndex.get('6')).toBe('アナルビーズ');
    expect(merged).toEqual({ addedIndex: 1, addedName: 1 });
  });

  it('同名字**跨编号**相撞时主表胜出（两版语料实测 0 例，规则照样钉死）', () => {
    const table = parseVariableCsv('4,バイブ\n');
    const merged = mergeVariableTable(table, '5,バイブ\n');
    expect(table.byName.get('バイブ')).toBe('4'); // 名称仍指主表编号
    expect(table.byIndex.get('5')).toBe('バイブ'); // 编号侧的新键照收
    expect(merged).toEqual({ addedIndex: 1, addedName: 0 });
  });

  it('同一份表内同编号两个名字（Base.als:10-11 简繁双写）：编号取首条，两名都收', () => {
    const t = parseVariableCsv('10,情绪\n10,情緒\n');
    expect(t.byIndex.get('10')).toBe('情绪');
    expect(t.byName.get('情绪')).toBe('10');
    expect(t.byName.get('情緒')).toBe('10');
  });
});

describe('parseVariableCsv 对 `.als` 的行格式实测（不照抄 `.csv` 的假设）', () => {
  it('`.als` 真实头部逐行可解：`;` 注释、空行、第四列、被注释掉的编号都不进表', () => {
    // 摘自 Item.als:1-8 原文
    const t = parseVariableCsv(
      ['0,ローター,3000,', '1,Ｅマッサージャ,9000,', '2,クリキャップ,3000,', '', ';7,空気ポンプ,6000,', '4,バイブ,4500,'].join('\n'),
    );
    expect(t.byIndex.get('0')).toBe('ローター');
    expect(t.byIndex.get('4')).toBe('バイブ');
    expect(t.byIndex.has('7')).toBe(false); // `;` 行没混进来
    expect(t.byIndex.size).toBe(4);
  });

  it('BOM 与无 BOM、LF 与 CRLF、有尾换行与无尾换行都收（实测形态全在这四条里）', () => {
    const cases = [
      '\uFEFF145,泥酔\n',
      '145,泥酔\n',
      '\uFEFF145,泥酔', // 无尾换行（Mark.als / ex.als / DAY.als 等 8 份实测如此）
      '145,泥酔\r\n',
    ];
    for (const text of cases) {
      const t = parseVariableCsv(text);
      expect(t.byIndex.get('145'), JSON.stringify(text)).toBe('泥酔');
      expect(t.byName.get('泥酔'), JSON.stringify(text)).toBe('145');
    }
  });

  it('名称段里的行内 `;` **不截断**（DAY.als:3 实测形态；与 csv 侧同一规则，不为本批新开口径）', () => {
    // DAY.als:3 = `2,季節;（1=春 2=夏 3=秋 4=冬）`；DAY.csv:3 = `2,季節,;（…）`（注释在第三列）
    const als = parseVariableCsv('2,季節;（1=春 2=夏 3=秋 4=冬）\n');
    const csv = parseVariableCsv('2,季節,;（1=春 2=夏 3=秋 4=冬）\n');
    expect(csv.byIndex.get('2')).toBe('季節'); // 主表给的干净名字照旧可用
    expect(als.byIndex.get('2')).toBe('季節;（1=春 2=夏 3=秋 4=冬）'); // 追加表的尾巴名原样成键（不猜、不切）
  });
});

describe('loadEratwVariableSchema：`CSV/*.als` 进字典（P-10③ 具名核对扩族的唯一前置）', () => {
  const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  /** 主表 + 追加名表的真实成对形态（编号 145 / 1 两处冲突都是盘上原文） */
  const REAL_PAIR: [string, string][] = [
    ['TCVAR.csv', '144,薬\n145,烂醉\n146,不耐烦\n'], // TCVAR.csv:82-84
    ['TCVAR.als', '144,お薬\n145,泥酔\n146,待たぬ\n'], // TCVAR.als:75-77
    ['ex.csv', '0,Ｃ絶頂\n1,Ｖ絶頂\n2,Ａ絶頂\n'], // ex.csv:1-3
    ['ex.als', '0,Ｃ绝顶\n1,Ｖ绝顶\n2,Ａ绝顶\n'], // ex.als:1-3
  ];

  function pairIo(entries: [string, string][], opts: { dropAls?: boolean; fail?: string[] } = {}): FileIO {
    const text = new Map(entries);
    return {
      listDir: async () =>
        entries
          .filter(([name]) => !(opts.dropAls && /\.als$/i.test(name)))
          .map(([name]) => ({ name, path: `/game/CSV/${name}`, isDirectory: false }))
          .concat({ name: 'Chara', path: '/game/CSV/Chara', isDirectory: true }),
      readText: async (path: string) => {
        if (opts.fail?.some((f) => path.endsWith(f))) throw new Error(`模拟读取失败：${path}`);
        const body = text.get(path.replace(/^.*\//, ''));
        if (body === undefined) throw new Error(`没有这个文件：${path}`);
        return { path, text: body };
      },
    } as unknown as FileIO;
  }

  const load = (entries: [string, string][], opts: { dropAls?: boolean; fail?: string[] } = {}) =>
    loadEratwVariableSchema({ io: pairIo(entries, opts), csvDir: '/game/CSV', log: silentLog });

  it('正自证：`泥酔`（TCVAR.als:76）与 `Ｖ绝顶`（ex.als:2）经字典查得到，且编号正确', async () => {
    const schema = await load(REAL_PAIR);
    expect(schema.lookup('TCVAR', '泥酔')).toEqual({
      name: 'TCVAR',
      index: '泥酔',
      description: '泥酔',
      resolvedIndex: 145,
    });
    expect(schema.lookup('EX', 'Ｖ绝顶')?.resolvedIndex).toBe(1);
    // 注意：字典的表键来自文件名（`ex.als` → `EX`），**没有** `NOWEX` 这张表——
    // `NOWEX:具名` 经 `EX` 表核对是 kojo-sugar 侧"同名表候选"的职责，读数见
    // `packages/plugins/kojo-sugar/tests/family-name-index.test.ts`。
  });

  it('负自证（防假绿）：**不合并 `.als` 时这两个名字必须查无**', async () => {
    const schema = await load(REAL_PAIR, { dropAls: true });
    // 查无 = 只回显、不带 description / resolvedIndex（正是 `isRecorded` 判"表外"的形态）
    expect(schema.lookup('TCVAR', '泥酔')).toEqual({ name: 'TCVAR', index: '泥酔' });
    expect(schema.lookup('EX', 'Ｖ绝顶')).toEqual({ name: 'EX', index: 'Ｖ绝顶' });
    // 而主表写法照旧查得到 ⇒ "查无"来自缺追加表，不是整张表没读进来
    expect(schema.lookup('TCVAR', '烂醉')?.resolvedIndex).toBe(145);
    expect(schema.lookup('EX', 'Ｖ絶頂')?.resolvedIndex).toBe(1);
  });

  it('主表已有编号的名称在两种口径下逐字相同（`.als` 一个都不许覆盖 ⇒ 悬停/降糖产物零变动）', async () => {
    const withAls = await load(REAL_PAIR);
    const csvOnly = await load(REAL_PAIR, { dropAls: true });
    for (const [fam, idx] of [
      ['TCVAR', 144],
      ['TCVAR', 145],
      ['TCVAR', 146],
      ['EX', 0],
      ['EX', 1],
      ['EX', 2],
    ] as const) {
      expect(withAls.lookup(fam, idx), `${fam}:${idx}`).toEqual(csvOnly.lookup(fam, idx));
    }
    expect(withAls.lookup('TCVAR', 145)?.description).toBe('烂醉');
    expect(withAls.lookup('EX', 1)?.description).toBe('Ｖ絶頂');
  });

  it('枚举顺序无关：`.als` 排在 `.csv` 前面也仍是主表优先（目录枚举就是这个名字顺序）', async () => {
    const schema = await load([...REAL_PAIR].reverse());
    expect(schema.lookup('TCVAR', 145)?.description).toBe('烂醉');
    expect(schema.lookup('TCVAR', '泥酔')?.resolvedIndex).toBe(145);
  });

  it('只有 `.als`、没有同名 `.csv` 时照样建表（魔王改版 BUFF.als 实测形态）', async () => {
    const schema = await load([['BUFF.als', '1,状態A\n2,状態B\n']]);
    expect(schema.lookup('BUFF', '状態B')?.resolvedIndex).toBe(2);
    expect(schema.lookup('BUFF', 1)?.description).toBe('状態A');
  });

  it('`.als` 读失败：主表照旧可用，且失败必须进日志（铁律 4：不许静默）', async () => {
    const warnings: string[] = [];
    const schema = await loadEratwVariableSchema({
      io: pairIo(REAL_PAIR, { fail: ['TCVAR.als'] }),
      csvDir: '/game/CSV',
      log: { ...silentLog, warn: (m: string) => warnings.push(m) },
    });
    expect(schema.lookup('TCVAR', '烂醉')?.resolvedIndex).toBe(145); // 主表没被牵连
    expect(schema.lookup('TCVAR', '泥酔')?.resolvedIndex).toBeUndefined(); // 追加名确实没进来
    expect(warnings.some((w) => w.includes('TCVAR.als'))).toBe(true);
  });

  it('inputDigest 把 `.als` 算作字典输入（追加表改一行，派生缓存必须失效）', async () => {
    const base = await load(REAL_PAIR);
    const noAls = await load(REAL_PAIR, { dropAls: true });
    const edited = await load(
      REAL_PAIR.map(([n, t]) => (n === 'TCVAR.als' ? [n, t.replace('泥酔', '泥醉')] : [n, t])) as [string, string][],
    );
    expect(base.inputDigest).not.toBe(noAls.inputDigest);
    expect(base.inputDigest).not.toBe(edited.inputDigest);
  });
});
