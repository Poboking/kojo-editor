/**
 * 家族识别（`parseKojoFamily`）判据 + 真盘覆盖率闸。
 *
 * 合成用例覆盖四种形态（裸尾号主族 / `_K{n}` 的 SELF 与 SINGLE / 前缀零填充 `K01_KOJO2` /
 * 带注释与形参表的脏名）与伪家族排除；形态清单与读数出处见 `src/family-index.ts` 文件头。
 * 真盘用例（`C:/game/eraAV/ERB/Lines`）用 `skipIf` 守卫——语料目录整目录暂离时本组自动跳过。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  characterNoOfFunction,
  createEraavFamilyIndex,
  ERAAV_FACE_LABELS,
  parseKojoFamily,
} from '../src/family-index';

describe('parseKojoFamily —— 主族裸尾号（无 K）', () => {
  it('`KOJO_MESSAGE_COM_1` → 面 MESSAGE_COM / 角色 1', () => {
    expect(parseKojoFamily('KOJO_MESSAGE_COM_1')).toMatchObject({
      kind: 'ok',
      prefix: 'KOJO',
      face: 'MESSAGE_COM',
      characterNo: 1,
      family: '',
      slot: '',
    });
  });

  it('PALAMCNG / MARKCNG 同形态', () => {
    expect(parseKojoFamily('KOJO_MESSAGE_PALAMCNG_5')).toMatchObject({ face: 'MESSAGE_PALAMCNG', characterNo: 5 });
    expect(parseKojoFamily('KOJO_MESSAGE_MARKCNG_29')).toMatchObject({ face: 'MESSAGE_MARKCNG', characterNo: 29 });
  });

  it('主路由驱动的裸尾号面（真盘 0 定义，形态有路由实证）：LESPLAY / NTR_STAFF', () => {
    expect(parseKojoFamily('KOJO_LESPLAY_12')).toMatchObject({ face: 'LESPLAY', characterNo: 12 });
    expect(parseKojoFamily('KOJO_NTR_STAFF_45')).toMatchObject({ face: 'NTR_STAFF', characterNo: 45 });
  });

  it('无前号的裸路由不是家族：`KOJO_MESSAGE_COM` → null', () => {
    expect(parseKojoFamily('KOJO_MESSAGE_COM')).toBeNull();
    expect(parseKojoFamily('KOJO_MESSAGE_PALAMCNG')).toBeNull();
  });
});

describe('parseKojoFamily —— 带 K 的 SELF 与 SINGLE', () => {
  it('`SELF_KOJO_K10` / `SINGLE_ENDING_K10` → 号取 `K` 后数字', () => {
    expect(parseKojoFamily('SELF_KOJO_K10')).toMatchObject({ prefix: 'SELF', face: 'SELF_KOJO', characterNo: 10 });
    expect(parseKojoFamily('SINGLE_ENDING_K10')).toMatchObject({
      prefix: 'SINGLE',
      face: 'SINGLE_ENDING',
      characterNo: 10,
    });
  });

  it('`SELF_KOJO`（无号路由本体）→ null', () => {
    expect(parseKojoFamily('SELF_KOJO')).toBeNull();
    expect(parseKojoFamily('SINGLE_ENDING')).toBeNull();
  });
});

describe('parseKojoFamily —— 作者工具族 `K{01}_KOJO2`（前缀零填充）', () => {
  it('`K01_KOJO2` → kind kn / 号 1（零填充归一）', () => {
    const m = parseKojoFamily('K01_KOJO2');
    expect(m).toMatchObject({ kind: 'kn', face: 'KOJO2', characterNo: 1 });
  });

  it('`K100_KOJO2` 非填充同判据', () => {
    expect(parseKojoFamily('K100_KOJO2')).toMatchObject({ kind: 'kn', characterNo: 100 });
  });

  it('非 KOJO2 尾巴的 `K{n}_` 助手不收（白名单，不编造家族）', () => {
    expect(parseKojoFamily('K10_KOJO3')).toBeNull();
    expect(parseKojoFamily('K10_SOMETHING')).toBeNull();
  });
});

describe('parseKojoFamily —— 脏名（真盘 `EVENT_K10_桐生歌音.ERB` / `EVENT_K30_文野柚香.ERB` 实形）', () => {
  it('`;` 中文注释被裁掉，且**注释里的号绝不进 characterNo**', () => {
    expect(parseKojoFamily('K10_KOJO2 ;因为是歌音的番号是10，所以这里改成了K10')).toMatchObject({
      face: 'KOJO2',
      characterNo: 10,
    });
    // 注释写着 45、实号 30——判 30
    expect(parseKojoFamily('KOJO_MESSAGE_COM_30 ;因为是由加子的番号是45，所以这里改成了45')).toMatchObject({
      face: 'MESSAGE_COM',
      characterNo: 30,
    });
  });

  it('定义行带形参表：`KOJO_LESPLAY_12,ARG:1` / 括号实参形态', () => {
    expect(parseKojoFamily('KOJO_LESPLAY_12,ARG:1')).toMatchObject({ face: 'LESPLAY', characterNo: 12 });
    expect(parseKojoFamily('SELF_KOJO_K5(ARG:0 = 0)')).toMatchObject({ face: 'SELF_KOJO', characterNo: 5 });
  });
});

describe('parseKojoFamily —— 伪家族与助手一律 null', () => {
  it('引擎钩子 EVENTTRAIN / EVENTEND（真盘各 34 处）不是口上家族', () => {
    expect(parseKojoFamily('EVENTTRAIN')).toBeNull();
    expect(parseKojoFamily('EVENTEND')).toBeNull();
  });

  it('`EVENT` 打头的作者助手（48 个的代表）不收', () => {
    expect(parseKojoFamily('EVENT_SEITSU')).toBeNull();
    expect(parseKojoFamily('EVENT_LESPLAY_NEW')).toBeNull();
    expect(parseKojoFamily('BLACKGIRL_EVENT')).toBeNull();
  });

  it('全局兜底 MAEKOJO_*（无角色号）不收', () => {
    expect(parseKojoFamily('MAEKOJO_NTR_STAFF')).toBeNull();
    expect(parseKojoFamily('MAEKOJO_LESPLAY')).toBeNull();
  });

  it('空串 / 占位尾号 / 未知后缀一律 null（fail-visible，不猜）', () => {
    expect(parseKojoFamily('')).toBeNull();
    expect(parseKojoFamily('KOJO_MESSAGE_COM_X1')).toBeNull();
    expect(parseKojoFamily('KOJO_MESSAGE_UNKNOWN_1')).toBeNull();
  });
});

describe('characterNoOfFunction —— 三形态各自取号', () => {
  it('裸尾号 / `_K{n}` / 前缀零填充各拿各的号', () => {
    expect(characterNoOfFunction('KOJO_MESSAGE_COM_45')).toBe(45);
    expect(characterNoOfFunction('SELF_KOJO_K10')).toBe(10);
    expect(characterNoOfFunction('K01_KOJO2')).toBe(1);
    expect(characterNoOfFunction('KOJO_MESSAGE_COM_30 ;因为是由加子的番号是45')).toBe(30);
  });

  it('解析不出返回 null，不抛', () => {
    expect(characterNoOfFunction('EVENTTRAIN')).toBeNull();
    expect(characterNoOfFunction('随便什么助手名')).toBeNull();
  });
});

describe('parseKojoFamily —— 重号与缺族不抛（健壮性）', () => {
  it('同角色多面对应同实号；缺族文件不抛异常', () => {
    const faces = ['KOJO_MESSAGE_COM_30', 'K30_KOJO2']; // 文野柚香：只有 COM + KOJO2，缺 SELF/PALAMCNG/MARKCNG
    for (const name of faces) expect(() => parseKojoFamily(name)).not.toThrow();
    expect(faces.map(characterNoOfFunction)).toEqual([30, 30]);
    expect(() => parseKojoFamily('KOJO_MESSAGE_PALAMCNG_30')).not.toThrow(); // 真盘缺定义，形态照判
  });
});

describe('createEraavFamilyIndex —— 契约位', () => {
  it('名称 / 面标签 / match 委派；不声明 instructionFaces（本作一指令一函数不存在）', () => {
    const rule = createEraavFamilyIndex();
    expect(rule.name).toBe('eraav-family-index');
    expect(rule.faceLabels?.MESSAGE_COM).toBe('指令口上');
    expect(rule.faceLabels?.KOJO2).toBe('口上2.0追加');
    expect(rule.instructionFaces).toBeUndefined();
    expect(rule.match('KOJO_MESSAGE_MARKCNG_1')?.face).toBe('MESSAGE_MARKCNG');
    expect(rule.match('K01_KOJO2', 'ERB/Lines/EVENT_K01_宮間かなで.ERB')?.characterNo).toBe(1);
  });

  it('面标签覆盖全部白名单面（八面，无漏网 token）', () => {
    const faces = ['MESSAGE_COM', 'MESSAGE_PALAMCNG', 'MESSAGE_MARKCNG', 'SELF_KOJO', 'SINGLE_ENDING', 'LESPLAY', 'NTR_STAFF', 'KOJO2'];
    for (const f of faces) expect(ERAAV_FACE_LABELS[f]).toBeTruthy();
  });
});

// ————— 真盘覆盖率闸（P1 验收物；目录暂离自动跳过） —————

const ERAAV_ROOT = process.env.KOJO_ERAAV_DIR ?? 'C:/game/eraAV';
const LINES_DIR = join(ERAAV_ROOT, 'ERB', 'Lines');
const REAL = existsSync(LINES_DIR);

/** 与内核定义行同判据：行首 `@`（`;` 注释行行中的 `@` 天然不取） */
const DEF_RE = /^\s*@([^\s;(（,，]+)/u;

describe.skipIf(!REAL)('parseKojoFamily —— 真盘覆盖率闸（ERB/Lines）', () => {
  it('17 份文件 150 个定义命中 82（54.7%）；未命中全部是 EVENTTRAIN/EVENTEND 引擎钩子', () => {
    const files = readdirSync(LINES_DIR).filter((f) => /\.erb$/i.test(f));
    expect(files).toHaveLength(17);
    let total = 0;
    let hit = 0;
    const misses = new Set<string>();
    for (const f of files) {
      for (const line of readFileSync(join(LINES_DIR, f), 'utf8').split(/\r?\n/)) {
        const m = DEF_RE.exec(line);
        if (!m) continue;
        total += 1;
        if (parseKojoFamily(m[1]!) !== null) hit += 1;
        else misses.add(m[1]!.toUpperCase());
      }
    }
    // 读数钉死（盘被改写会逼着重跑口径，而不是悄悄漂移）
    expect(total).toBe(150);
    expect(hit).toBe(82);
    expect([...misses].sort()).toEqual(['EVENTEND', 'EVENTTRAIN']);
    // eslint-disable-next-line no-console
    console.info(`[eraav family-index] 真盘覆盖率 ${hit}/${total} = ${((hit / total) * 100).toFixed(1)}%，未命中=${[...misses].join(',')}`);
  });

  it('注释形态的 SINGLE_ENDING（`;@SINGLE_ENDING_K{n}`）不会被行首定义正则取到', () => {
    const t = readFileSync(join(LINES_DIR, 'EVENT_K10_桐生歌音.ERB'), 'utf8');
    const commented = [...t.matchAll(/^;@SINGLE_ENDING_K\d+$/gmu)].length;
    expect(commented).toBeGreaterThanOrEqual(1);
    const DEF_RE_G = /^[ \t]*@([^\s;(（,，]+)/gmu;
    expect([...t.matchAll(DEF_RE_G)].some((m) => /^SINGLE_ENDING_K/i.test(m[1] ?? ''))).toBe(false);
  });
});
