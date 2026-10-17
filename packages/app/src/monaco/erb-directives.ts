/**
 * ERB (EraBasic) 指令词表 —— 宿主层**单一真源**（叶子模块：零 import，无模块环）。
 *
 * 为什么单独成叶：同一份词表要被两处语言定义共用——`.erb` 的 Monarch（`erb-language.ts`）
 * 与 `.kojo` 原生直通行高亮（`kojo-language.ts`）。而 `erb-language.ts` → `theme.ts` →
 * `kojo-language.ts` 已有模块环，kojo 侧若 import `erb-language.ts` 就踩 TDZ；
 * 词表自身零依赖 ⇒ 叶子模块是唯一无环形态，`erb-language.ts` 原样 re-export 保旧 import 点。
 *
 * 口径 = **口上高频子集**（非 Emuera 全集，不收冷门货）。补齐依据：eraTW 4.980 真实语料
 * （ERB 全树 3,980 文件）实测词频 ≥1000 的缺失名——PRINTFORMDW / PRINTFORMDL / DATAFORM /
 * RETURNF / PRINTDW / PRINTDL / GOTO / VARSET / DATALIST / ENDLIST / PRINTFORMD / DOWNBASE /
 * GETNUM / PRINTBUTTON；下一档（HTML_PRINT 519 / REDRAW 307 / FORCEWAIT 162 …）不收。
 * 同族但语料零命中的 L/W 组合（PRINTLW / PRINTFORMLW / PRINTDATALW / PRINTFORMDLW）同样拒收——
 * "族完整性"不是收录理由，"作者真在写"才是。
 *
 * 族头词（CFLAG / DOWNBASE …）在此照收不误：`.erb` 侧统一 keyword 档即正确；`.kojo` 侧
 * 由 `FAMILY_HEAD_SET` 滤出另立 `keyword.erb.family` 档（`kojo-language.ts` 派生处）。
 */
export const ERB_DIRECTIVES: readonly string[] = [
  'PRINT', 'PRINTL', 'PRINTW', 'PRINTV', 'PRINTVL',
  'PRINTFORM', 'PRINTFORML', 'PRINTFORMS', 'PRINTFORMW', 'PRINTFORMV',
  'PRINTDATA', 'PRINTDATAL', 'PRINTDATAW', 'PRINTDATAS',
  'PRINTDW', 'PRINTDL',
  'PRINTFORMD', 'PRINTFORMDL', 'PRINTFORMDW',
  'DATAFORM', 'DATALIST', 'ENDLIST',
  'PRINTSINGLE', 'PRINTSINGLEL', 'PRINTSINGLEFORM', 'PRINTSINGLEFORML',
  'PRINTBUTTON',
  'IF', 'ELSEIF', 'ELSE', 'ENDIF', 'SIF',
  'SELECTCASE', 'CASE', 'CASEELSE', 'ENDSELECT',
  'FOR', 'NEXT', 'WHILE', 'WEND', 'DO', 'LOOP', 'REPEAT', 'REND', 'BREAK', 'CONTINUE', 'RETURN', 'RETURNF',
  'GOTO',
  'CALL', 'CALLL', 'JUMP', 'CALLFORM', 'CALLFORML', 'TRYCALLFORM', 'TRYCALLFORMF',
  'TRYCALL', 'TRYJUMP', 'TRYCCALLFORM', 'CALLF', 'CALLFORMF',
  'DIM', 'DIMS', 'SWAP', 'VARSET',
  'SETCOLOR', 'RESETCOLOR', 'FONTBOLD', 'FONTITALIC', 'FONTREGULAR', 'FONTSIZE', 'FONTSTYLE',
  'WAIT', 'WAITANYKEY', 'INPUT', 'INPUTS', 'ONEINPUT', 'TINPUT', 'TINPUTS', 'TWAIT',
  'STRDATA', 'SAVEDATA', 'LOADDATA', 'DELDATA', 'SAVEGLOBAL', 'LOADGLOBAL',
  'GETTIME', 'GETMILLISECOND', 'SETBIT', 'CLEARBIT', 'INVERTBIT', 'GETBIT', 'SETCOLORBYNAME',
  'RANDOMIZE', 'RAND', 'TIMES', 'EXISTCSV', 'GETNUM', 'BAR', 'BARL', 'DRAWLINE', 'CLEARLINE', 'ALIGNMENT',
  'ADDCHARA', 'ADDSPCHARA', 'DELCHARA', 'SWAPCHARA', 'PICKUPCHARA', 'GETCHARA', 'CHKCHARA',
  'EQUIP', 'UNEQUIP', 'EQUIPCHECK', 'CHANGE_CFLAG', 'CFLAG', 'DOWNBASE', 'RESETDATA', 'BEGIN', 'EVENTCOM',
];