/**
 * 家族识别（`parseKojoFamily`）判据 + 真盘覆盖率闸。
 *
 * 合成用例覆盖：主族（族+号+类别）、**指令号尾槽**、`NO9`／性器／性别三类并列族、
 * 优先层与立场层叠词、小面（COLOR/SETUP/DIGEST…）、存在判定声明形、`_KX` 模板化石，
 * 以及三条**必须为 null** 的排除线（`M_KOJO` 伪命中、连写引擎事件、作者私有函数）。
 * 形态清单、面词表与读数出处见 `src/family-index.ts` 文件头。
 *
 * 真盘用例（`C:/game/eratohoReverse/ERB/口上`）一律 `skipIf` 守卫——语料整目录暂离时自动跳过。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  characterNoOfFunction,
  createEratohoreverseFamilyIndex,
  ERATOHOREVERSE_FACE_LABELS,
  parseKojoFamily,
} from '../src/family-index';

/* --------------------------- 主族：族 + 号 + 类别 --------------------------- */

describe('parseKojoFamily —— 主族（面在锚点之前、类别在锚点之后）', () => {
  it('`KOJO_ACT_K1_愛撫` → 面 ACT / 角色 1 / 类别进 slot / 基础家族（family 空）', () => {
    const m = parseKojoFamily('KOJO_ACT_K1_愛撫');
    expect(m).toMatchObject({
      kind: 'ok',
      prefix: 'KOJO',
      family: '',
      face: 'ACT',
      characterNo: 1,
      slot: '愛撫',
      sub: '',
      isMessageCheck: false,
      isPlaceholder: false,
    });
  });

  it('真盘形是数字类别：`KOJO_ACT_K1_0`（`ACT_00_会話_K1.ERB:30`）→ slot 原样', () => {
    expect(parseKojoFamily('KOJO_ACT_K1_0')).toMatchObject({ face: 'ACT', characterNo: 1, slot: '0' });
    expect(parseKojoFamily('KOJO_REACT_K13_10')).toMatchObject({ face: 'REACT', characterNo: 13, slot: '10' });
  });

  it('无类别的通用形（路由 `ACT_K{NO:TARGET}` 那一路）：slot 空', () => {
    expect(parseKojoFamily('KOJO_ACT_K1')).toMatchObject({ face: 'ACT', characterNo: 1, slot: '' });
    expect(parseKojoFamily('KOJO_REACT_K1')).toMatchObject({ face: 'REACT', slot: '' });
  });

  it('助手与追加行动面：整段面名不拆', () => {
    expect(parseKojoFamily('KOJO_ACT_ASSI_K1_0')).toMatchObject({ family: '', face: 'ACT_ASSI', slot: '0' });
    expect(parseKojoFamily('KOJO_ACT_EXTRA_K1_11')).toMatchObject({ face: 'ACT_EXTRA', characterNo: 1, slot: '11' });
    expect(parseKojoFamily('KOJO_EVENT_ASSI_K1_201')).toMatchObject({ face: 'EVENT_ASSI' });
    expect(parseKojoFamily('KOJO_DATUI_ASSI_K1')).toMatchObject({ face: 'DATUI_ASSI', slot: '' });
  });

  it('面段自带数字不是角色号：`KOJO_TRAIN_MESSAGE2_K11_0` → 面 TRAIN_MESSAGE2 / 号 11', () => {
    expect(parseKojoFamily('KOJO_TRAIN_MESSAGE2_K11_0')).toMatchObject({
      face: 'TRAIN_MESSAGE2',
      characterNo: 11,
      slot: '0',
    });
    expect(parseKojoFamily('KOJO_TRAIN_MESSAGE_K11_0')).toMatchObject({ face: 'TRAIN_MESSAGE', characterNo: 11 });
  });

  it('尾段**整段**进 slot，不裁首段（真盘实形）', () => {
    expect(parseKojoFamily('KOJO_ACT_K4_26_OLD')).toMatchObject({ face: 'ACT', characterNo: 4, slot: '26_OLD' });
    expect(parseKojoFamily('KOJO_EVENT_K52_AMIBA_EVENT')).toMatchObject({
      face: 'EVENT',
      characterNo: 52,
      slot: 'AMIBA_EVENT',
    });
    expect(parseKojoFamily('KOJO_REACT_K13_性奉共通')).toMatchObject({ face: 'REACT', slot: '性奉共通' });
  });

  it('形参表被裁掉：`KOJO_POSE_K14(ARG, ARG:1, ARG:2)` / `KOJO_RAND_K14(ARGS, ARG)`', () => {
    expect(parseKojoFamily('KOJO_POSE_K14(ARG, ARG:1, ARG:2)')).toMatchObject({ face: 'POSE', characterNo: 14 });
    expect(parseKojoFamily('KOJO_RAND_K14(ARGS, ARG)')).toMatchObject({ face: 'RAND', characterNo: 14, slot: '' });
  });
});

/* ----------------------- 指令号尾槽（instructionFaces）----------------------- */

describe('parseKojoFamily —— 指令号尾槽（本作独有，eraTW/hok 形态不可照抄）', () => {
  it('`KOJO_COM_K1_12` → 面 COM / slot = SELECTCOM 指令号 12', () => {
    expect(parseKojoFamily('KOJO_COM_K1_12')).toMatchObject({
      family: '',
      face: 'COM',
      characterNo: 1,
      slot: '12',
    });
    // 真盘 COM 尾号带空缺段（0–8 / 10–16 / 20–22 / 30–33 / 40–44 / 50–52 / 70–71 = Train.csv 行号）
    for (const no of ['0', '8', '10', '16', '20', '33', '44', '52', '70', '71']) {
      expect(parseKojoFamily(`KOJO_COM_K1_${no}`)?.slot).toBe(no);
    }
  });

  it('动作号不是指令号：ACT/REACT/TRAIN_MESSAGE 的 slot 同形但语义不同 ⇒ 只有 COM 上矩阵', () => {
    expect(parseKojoFamily('KOJO_ACT_K1_312')).toMatchObject({ face: 'ACT', slot: '312' });
    expect(createEratohoreverseFamilyIndex().instructionFaces).toEqual(['COM']);
  });
});

/* ------------------------- 并列族：NO9 / 性器 / 性别 ------------------------- */

describe('parseKojoFamily —— 并列族进 family（面仍由 face 承担）', () => {
  it('`KOJO_NO9_TRAIN_MESSAGE_K11_0` → family NO9（`KOJO_NO{NO:MASTER}_%ARGS%`）', () => {
    expect(parseKojoFamily('KOJO_NO9_TRAIN_MESSAGE_K11_0')).toMatchObject({
      family: 'NO9',
      face: 'TRAIN_MESSAGE',
      characterNo: 11,
      slot: '0',
    });
    expect(parseKojoFamily('KOJO_NO9_COM_K1_30')).toMatchObject({ family: 'NO9', face: 'COM', slot: '30' });
  });

  it('家族段可**叠两层**，按名内顺序连接：`KOJO_NO9_MS_ACT_K14_1`', () => {
    expect(parseKojoFamily('KOJO_NO9_MS_ACT_K14_1')).toMatchObject({ family: 'NO9_MS', face: 'ACT' });
    expect(parseKojoFamily('KOJO_MALE_NO9_TRAIN_MESSAGE_K1_0')).toMatchObject({
      family: 'MALE_NO9',
      face: 'TRAIN_MESSAGE',
    });
  });

  it('性器族 `KOJO_FEMALEYOU_*`（`0022_紫/KOJO_K22.ERB:48`）与不带 YOU 的性别族各自成形', () => {
    expect(parseKojoFamily('KOJO_FEMALEYOU_EXCLUSION_K22')).toMatchObject({
      family: 'FEMALEYOU',
      face: 'EXCLUSION',
      characterNo: 22,
    });
    for (const g of ['MALEYOU', 'TWINYOU', 'PENISYOU', 'FEMALEYOU']) {
      expect(parseKojoFamily(`KOJO_${g}_ACT_K1_0`)).toMatchObject({ family: g, face: 'ACT' });
    }
    for (const g of ['MALE', 'TWIN', 'PENIS', 'FEMALE']) {
      expect(parseKojoFamily(`KOJO_${g}_REACT_K1_0`)).toMatchObject({ family: g, face: 'REACT' });
    }
    // YOU 与不带 YOU 是**两个家族**（路由 `:573-664` vs `:710-757`），不许合并
    expect(parseKojoFamily('KOJO_MALE_ACT_K1_1')?.family).not.toBe(parseKojoFamily('KOJO_MALEYOU_ACT_K1_1')?.family);
  });

  it('立场层 MS / AS / SP 各成一族：`KOJO_MS_EVENT_K1_11`（`EVENT_K.ERB:525`）', () => {
    expect(parseKojoFamily('KOJO_MS_EVENT_K1_11')).toMatchObject({ family: 'MS', face: 'EVENT', slot: '11' });
    expect(parseKojoFamily('KOJO_AS_EVENT_K1_11')).toMatchObject({ family: 'AS', face: 'EVENT' });
    expect(parseKojoFamily('KOJO_SP_TRAIN_MESSAGE_K1_0')).toMatchObject({ family: 'SP', face: 'TRAIN_MESSAGE' });
    expect(parseKojoFamily('KOJO_MS_EXCLUSION_K1')).toMatchObject({ family: 'MS', face: 'EXCLUSION', slot: '' });
  });

  it('模板立场槽 `Y1` 也进 family（`0001_霊夢/KOJO_K1.ERB:55` 注释直说 Y1 要换成 MALEYOU/NO{n}/…）', () => {
    expect(parseKojoFamily('KOJO_Y1_EXCLUSION_K1')).toMatchObject({ family: 'Y1', face: 'EXCLUSION', characterNo: 1 });
  });

  it('优先层 PRI1..3 是家族段，与 PRIORITY1..3 判定面**不是一回事**', () => {
    expect(parseKojoFamily('KOJO_PRI1_EVENT_K14_11(ARG)')).toMatchObject({
      family: 'PRI1',
      face: 'EVENT',
      characterNo: 14,
      slot: '11',
    });
    expect(parseKojoFamily('KOJO_PRI1_MS_EVENT_K14_2')).toMatchObject({ family: 'PRI1_MS', face: 'EVENT' });
    expect(parseKojoFamily('KOJO_PRIORITY1_K14')).toMatchObject({ family: '', face: 'PRIORITY1', characterNo: 14 });
  });
});

/* ------------------------------- 小面 / 声明 ------------------------------- */

describe('parseKojoFamily —— 小面与存在判定声明', () => {
  it('小面各自成面（真盘 `0001_霊夢/KOJO_K1.ERB:75/108/119/130`）', () => {
    expect(parseKojoFamily('KOJO_COLOR_K1')).toMatchObject({ face: 'COLOR', characterNo: 1, slot: '' });
    expect(parseKojoFamily('KOJO_SETUP_K1')).toMatchObject({ face: 'SETUP' });
    expect(parseKojoFamily('KOJO_DIGEST_K1')).toMatchObject({ face: 'DIGEST' });
    expect(parseKojoFamily('KOJO_ATTENTION_K1')).toMatchObject({ face: 'ATTENTION' });
    expect(parseKojoFamily('KOJO_MARK_K1')).toMatchObject({ face: 'MARK' });
    expect(parseKojoFamily('KOJO_DATUI_K1')).toMatchObject({ face: 'DATUI' });
    expect(parseKojoFamily('KOJO_USE_K1')).toMatchObject({ face: 'USE' });
    expect(parseKojoFamily('KOJO_TRAIN_MESSAGE_ANIME_K1')).toMatchObject({ face: 'TRAIN_MESSAGE_ANIME' });
    expect(parseKojoFamily('KOJO_REACTION_MESSAGE_K14_0')).toMatchObject({
      family: '',
      face: 'REACTION_MESSAGE',
      characterNo: 14,
      slot: '0',
    });
  });

  it('`KOJO_K1`（口上存在判定／`TRYCALLFORM KOJO_K{ARG}`）→ declare 形', () => {
    const m = parseKojoFamily('KOJO_K1');
    expect(m).toMatchObject({ kind: 'declare', prefix: 'KOJO', family: '', face: 'KOJO', characterNo: 1, slot: '' });
  });

  it('路由终端**没有** `_K{数字}` ⇒ 一律 null（不是任何角色的口上）', () => {
    for (const n of ['KOJO_BAA', 'KOJO_CALL', 'KOJO_CALL2', 'KOJO_CHECK', 'KOJO_ACT', 'KOJO_REACT', 'KOJO_EVENT', 'KOJO_COLOR', 'KOJO_PROFILE']) {
      expect(parseKojoFamily(n), n).toBeNull();
    }
  });
});

/* ------------------------------ 排除线（钉死） ------------------------------ */

describe('parseKojoFamily —— `M_KOJO` 陷阱：本作只认 `^KOJO_`', () => {
  it('`ACTM_KOJO_CORRECTION` 系列是**子串伪命中**（真盘 11 处 `M_KOJO` 全是它）⇒ null', () => {
    expect(parseKojoFamily('ACT_ACTM_KOJO_CORRECTION_T')).toBeNull();
    expect(parseKojoFamily('ACTM_KOJO_CORRECTION')).toBeNull();
    expect(parseKojoFamily('ACTM_KOJO_CORRECTION_T(ARG)')).toBeNull();
  });

  it('eraTW 的中缀家族形在本作不是家族：`M_KOJO_K1_2` / `M_KOJO_少女之梦_COLOR_K1` ⇒ null', () => {
    expect(parseKojoFamily('M_KOJO_K1_2')).toBeNull();
    expect(parseKojoFamily('M_KOJO_少女之梦_COLOR_K1')).toBeNull();
  });

  it('其它含 KOJO 字样的作者函数同挡：`PRINT_KOJO_*` / `K64_KOJO_COLOR` / `CHK_…_KOJORAND_K14`', () => {
    expect(parseKojoFamily('PRINT_KOJO_ACT_GRU10_1_K39')).toBeNull();
    expect(parseKojoFamily('K64_KOJO_COLOR')).toBeNull();
    expect(parseKojoFamily('CHK_FADECONFIG_OUTPUT_OF_KOJORAND_K14')).toBeNull();
  });
});

describe('parseKojoFamily —— 引擎事件连写形不是口上家族', () => {
  it('真盘 11 处连写事件（`@EVENTFIRST`…`@EVENTCOMEND`）全部 null；下划线式与 `@EVENTBUY` 盘上没有', () => {
    for (const n of ['EVENTFIRST', 'EVENTLOAD', 'EVENTTRAIN', 'EVENTTURNEND', 'EVENTCOM', 'EVENTSHOP', 'EVENTEND', 'EVENTCOMEND']) {
      expect(parseKojoFamily(n), n).toBeNull();
    }
    expect(parseKojoFamily('EVENT_1')).toBeNull();
    expect(parseKojoFamily('EVENTBUY')).toBeNull();
  });

  it('连写事件即便被冠上 `KOJO_` 也不认（无 `_K{数字}` 锚 ⇒ null，不猜）', () => {
    expect(parseKojoFamily('KOJO_EVENTFIRST')).toBeNull();
  });
});

describe('parseKojoFamily —— 纯作者私有函数一律 null', () => {
  it('非 `KOJO_` 前缀的私货（带 `_K{n}` 也不收）：显示工具 / 描写助手 / 中文命名', () => {
    for (const n of ['WARD_A_K14', 'PRINT_COMGRO_4_K14', 'FUNC_K13_CALLNAME', 'TV_EX_K14', 'COLOR_K14', 'TEXTDISPLAY_CATEGORY_5_REJECT_NO9_K14', '性交奉仕拒绝处理_K14', '施虐系解除处理_K14']) {
      expect(parseKojoFamily(n), n).toBeNull();
    }
  });

  it('排版化石（说明文字漏 `;` 顶到行首）既不是家族也不是占位符', () => {
    expect(parseKojoFamily('KOJO_TRAIN_MESSAGE_K[角色番号]_ACT[ACT番号]で旁白的插し替え、条件设定')).toBeNull();
    expect(parseKojoFamily('KOJO_ACTなり@KOJO_REACT终了时に是RESETCOLORされる')).toBeNull();
  });

  it('空串 / 垃圾 / 无锚点：null，不抛', () => {
    expect(parseKojoFamily('')).toBeNull();
    expect(parseKojoFamily('   ')).toBeNull();
    expect(parseKojoFamily('随便什么助手名')).toBeNull();
    expect(parseKojoFamily('KOJO_')).toBeNull();
    expect(() => parseKojoFamily('KOJO_ACT_K1_愛撫', 'ERB/口上/0001_霊夢/KOJO_ACT_K1/ACT_00_会話_K1.ERB')).not.toThrow();
  });
});

/* ------------------------------- 占位符形态 ------------------------------- */

describe('parseKojoFamily —— `_KX` 模板化石标占位符（校验器的直接目标）', () => {
  it('`KOJO_REACT_KXX_44`（真盘 1 处）→ kind placeholder / 不归属角色 / slot 保留', () => {
    expect(parseKojoFamily('KOJO_REACT_KXX_44')).toMatchObject({
      kind: 'placeholder',
      face: 'REACT',
      characterNo: null,
      isPlaceholder: true,
      slot: '44',
    });
  });

  it('光杆 `_K` 与分派器占位 `_K{対象NO}` 同判据', () => {
    expect(parseKojoFamily('KOJO_TRAIN_MESSAGE_K')).toMatchObject({ kind: 'placeholder', face: 'TRAIN_MESSAGE', characterNo: null });
    expect(parseKojoFamily('KOJO_ACT_K{対象NO}_0')).toMatchObject({ kind: 'placeholder', face: 'ACT', characterNo: null });
    expect(parseKojoFamily('KOJO_KX')).toMatchObject({ kind: 'placeholder', face: 'KOJO', characterNo: null });
  });

  it('filePath 是 additive：只为占位符按路径补号，其余判定逐字不变', () => {
    const fossil = 'KOJO_REACT_KXX_44';
    const path = 'ERB/口上/0014_アリス/限定無し_K14/KOJO_REACT_K14/REACT_04_羞恥_K14.ERB';
    expect(parseKojoFamily(fossil)).toMatchObject({ characterNo: null });
    expect(parseKojoFamily(fossil, path)?.characterNo).toBeNull(); // 名字解析路径不参与（占位对齐只在 rule.match）
    const rule = createEratohoreverseFamilyIndex();
    expect(rule.match(fossil, path)).toMatchObject({ isPlaceholder: true, characterNo: 14 });
    expect(rule.match(fossil)).toMatchObject({ isPlaceholder: true, characterNo: null });
    // 非占位符传不传路径同判据
    expect(rule.match('KOJO_COM_K1_12', path)).toEqual(rule.match('KOJO_COM_K1_12'));
  });
});

/* -------------------------- characterNoOfFunction -------------------------- */

describe('characterNoOfFunction —— 带号与不带号两类各自的表现', () => {
  it('带 `_K{n}`：号即锚点数字，尾槽（指令号/类别）不干扰', () => {
    expect(characterNoOfFunction('KOJO_COM_K1_12')).toBe(1);
    expect(characterNoOfFunction('KOJO_ACT_K1_愛撫')).toBe(1);
    expect(characterNoOfFunction('KOJO_NO9_MS_TRAIN_MESSAGE_K11_0')).toBe(11);
    expect(characterNoOfFunction('KOJO_FEMALEYOU_EXCLUSION_K22')).toBe(22);
    expect(characterNoOfFunction('KOJO_K1')).toBe(1);
    expect(characterNoOfFunction('KOJO_POSE_K14(ARG, ARG:1, ARG:2)')).toBe(14);
  });

  it('不带号：路由终端、作者私货（私货自己的 `_K{n}` 也不算家族号）、占位符 ⇒ 全 null', () => {
    expect(characterNoOfFunction('KOJO_ACT')).toBeNull();
    expect(characterNoOfFunction('KOJO_CHECK')).toBeNull();
    expect(characterNoOfFunction('WARD_A_K14')).toBeNull();
    expect(characterNoOfFunction('FUNC_K13_CALLNAME')).toBeNull();
    expect(characterNoOfFunction('KOJO_REACT_KXX_44')).toBeNull();
    expect(characterNoOfFunction('ACT_ACTM_KOJO_CORRECTION_T')).toBeNull();
    expect(characterNoOfFunction('')).toBeNull();
  });

  it('与 `parseKojoFamily` 同判据（不另开口径）', () => {
    for (const n of ['KOJO_MS_EVENT_K1_11', 'KOJO_K22', 'KOJO_PRIORITY1_K14', 'KOJO_BAA', 'COLOR_K14']) {
      expect(characterNoOfFunction(n)).toBe(parseKojoFamily(n)?.characterNo ?? null);
    }
  });
});

/* --------------------------------- 契约位 --------------------------------- */

describe('createEratohoreverseFamilyIndex —— 契约位', () => {
  it('name / match 委派 / instructionFaces 只声明 COM（裁决见 src 文件头）', () => {
    const rule = createEratohoreverseFamilyIndex();
    expect(rule.name).toBe('eratohoreverse-family-index');
    expect(rule.match('KOJO_COM_K1_12')?.face).toBe('COM');
    expect(rule.instructionFaces).toEqual(['COM']);
  });

  it('面标签是**中文**且覆盖路由面；作者一次性私货面刻意留白（原样显示 token）', () => {
    expect(ERATOHOREVERSE_FACE_LABELS.ACT).toBe('动作口上');
    expect(ERATOHOREVERSE_FACE_LABELS.COM).toBe('指令口上');
    expect(ERATOHOREVERSE_FACE_LABELS.KOJO).toBe('口上存在判定');
    expect(ERATOHOREVERSE_FACE_LABELS.DIGEST).toContain('梗概');
    expect(ERATOHOREVERSE_FACE_LABELS.COLOR).toBe('口上配色');
    for (const f of ['PRIORITY1', 'PRIORITY2', 'PRIORITY3', 'EXCLUSION', 'REACTION_MESSAGE']) {
      expect(ERATOHOREVERSE_FACE_LABELS[f], f).toBeTruthy();
    }
    for (const f of ['EV16', 'EV16_1', 'REACT_LUST', 'TRAIN_MESSAGE_SKIP']) {
      expect(ERATOHOREVERSE_FACE_LABELS[f], f).toBeUndefined();
    }
    // 标签一律不含日文假名（中文口径；`あらすじ` 只作括注）
    for (const [k, v] of Object.entries(ERATOHOREVERSE_FACE_LABELS)) {
      expect(/[\u3040-\u30ff]/.test(v.replace(/（[^）]*）/g, '')), `${k}=${v}`).toBe(false);
    }
  });
});

/* ---------------------------- 真盘覆盖率闸（skipIf） ---------------------------- */

const REAL_ROOT = process.env.KOJO_EVRSE_DIR ?? 'C:/game/eratohoReverse';
const KOJO_DIR = join(REAL_ROOT, 'ERB', '口上');
const REAL = existsSync(KOJO_DIR);

/** 与 erb-parser `parseFunctionDefinition` 同判据（编辑器函数树的口径） */
function defNameOf(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('@')) return null;
  const body = trimmed.slice(1);
  const first = body.search(/[^ \t\u3000]/);
  if (first < 0 || body[first] === '"') return null; // `@"…"` 是 FORM 续行
  let end = body.length;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === '(' || c === ',' || c === ' ' || c === '\t' || c === ';') {
      end = i;
      break;
    }
  }
  const name = body.slice(0, end).trim();
  return name.length > 0 ? name : null;
}

function erbFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (!st.isDirectory()) {
      if (/\.erb$/i.test(e)) out.push(p);
      continue;
    }
    out.push(...erbFiles(p));
  }
  return out;
}

describe.skipIf(!REAL)('parseKojoFamily —— 真盘覆盖率闸（ERB/口上 全量 5,796 个定义）', () => {
  it('命中 5,255 / 总数 5,796 = 90.67%；面 31 个，家族段 12 个', () => {
    const files = erbFiles(KOJO_DIR);
    expect(files, '口上域 ERB 份数').toHaveLength(633);
    let total = 0;
    let hit = 0;
    const faces = new Set<string>();
    const families = new Set<string>();
    for (const f of files) {
      const rel = f.slice(KOJO_DIR.length + 1).replaceAll('\\', '/');
      const text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      for (const line of text.split(/\r?\n/)) {
        const name = defNameOf(line);
        if (!name) continue;
        total += 1;
        const m = createEratohoreverseFamilyIndex().match(name, rel);
        if (m) {
          hit += 1;
          faces.add(m.face);
          families.add(m.family);
        }
      }
    }
    // 读数钉死（盘被改写会逼着重跑口径，而不是悄悄漂移）
    expect(total).toBe(5796);
    expect(hit).toBe(5255);
    expect(faces.size).toBe(31);
    expect(families.size).toBe(12);
    // eslint-disable-next-line no-console
    console.info(`[eratohoreverse family-index] 真盘覆盖率 ${hit}/${total} = ${((hit / total) * 100).toFixed(2)}%`);
  });

  it('未命中只有三类：路由终端 20 + 排版化石 2 + 作者私有 519', () => {
    const files = erbFiles(KOJO_DIR);
    const router: string[] = [];
    const fossil: string[] = [];
    const privateFns: string[] = [];
    for (const f of files) {
      const rel = f.slice(KOJO_DIR.length + 1).replaceAll('\\', '/');
      const text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const name = defNameOf(lines[i]!);
        if (!name) continue;
        if (parseKojoFamily(name)) continue;
        if (/^KOJO_[A-Z0-9_]+$/i.test(name)) router.push(`${name}@${rel}:${i + 1}`);
        else if (/^KOJO_/i.test(name)) fossil.push(`${name}@${rel}`);
        else privateFns.push(name);
      }
    }
    expect(router.sort()).toEqual([
      'KOJO_ACT@EVENT_K.ERB:335',
      'KOJO_ACT_ASSI@EVENT_K.ERB:400',
      'KOJO_ACT_EXTRA@EVENT_K.ERB:375',
      'KOJO_ATTENTION@EVENT_K.ERB:75',
      'KOJO_BAA@EVENT_K.ERB:12',
      'KOJO_CALL2@EVENT_K.ERB:561',
      'KOJO_CALL@EVENT_K.ERB:502',
      'KOJO_CHECK@EVENT_K.ERB:810',
      'KOJO_COLOR@EVENT_K.ERB:470',
      'KOJO_DATUI@EVENT_K.ERB:181',
      'KOJO_DIGEST@EVENT_K.ERB:50',
      'KOJO_EVENT@EVENT_K.ERB:100',
      'KOJO_EVENT_ASSI@EVENT_K.ERB:127',
      'KOJO_MARK@EVENT_K.ERB:155',
      'KOJO_POSE@EVENT_K.ERB:264',
      'KOJO_PROFILE@KOJO_PROFILE.ERB:4',
      'KOJO_REACT@EVENT_K.ERB:442',
      'KOJO_TRAIN_MESSAGE2@EVENT_K.ERB:310',
      'KOJO_TRAIN_MESSAGE@EVENT_K.ERB:287',
      'KOJO_USE@EVENT_K.ERB:420',
    ]);
    expect(fossil).toHaveLength(2);
    expect(privateFns).toHaveLength(519);
  });

  it('`M_KOJO` 陷阱归零：口上域内 0 处 `M_KOJO` 定义，全树唯一那处是 `ACT_ACTM_KOJO_CORRECTION_T`', () => {
    const inKojo: string[] = [];
    for (const f of erbFiles(KOJO_DIR)) {
      const text = readFileSync(f, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const name = defNameOf(line);
        if (name && /M_KOJO/i.test(name)) inKojo.push(name);
      }
    }
    expect(inKojo).toEqual([]);
    // 真盘 `ERB/TRAIN/ACT/PLAYER_ACTM/PLAYER_ACTM_PROCESS.ERB:111`
    expect(parseKojoFamily('ACT_ACTM_KOJO_CORRECTION_T', 'ERB/TRAIN/ACT/PLAYER_ACTM/PLAYER_ACTM_PROCESS.ERB')).toBeNull();
    expect(characterNoOfFunction('ACT_ACTM_KOJO_CORRECTION_T')).toBeNull();
  });

  it('引擎事件连写形 11 处全在 `ERB/口上` **之外**：口上域内没有任何 `@EVENT…` 定义', () => {
    const events: string[] = [];
    for (const f of erbFiles(KOJO_DIR)) {
      const text = readFileSync(f, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const name = defNameOf(line);
        if (name && /^EVENT/i.test(name)) events.push(name);
      }
    }
    expect(events).toEqual([]);
  });
});
