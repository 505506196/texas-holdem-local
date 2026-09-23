// 策略工具测试：MDF、牌面分类、SPR、河牌极化
const fs = require('fs');
const path = require('path');

global.window = {};
const src = ['cards.js', 'strategy.js', 'preflop.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8')).join('\n');
eval(src + `
  globalThis.mdf = mdf;
  globalThis.MDF_TABLE = MDF_TABLE;
  globalThis.bluffCatchEquity = bluffCatchEquity;
  globalThis.classifyBoard = classifyBoard;
  globalThis.sprBucket = sprBucket;
  globalThis.riverRole = riverRole;
  globalThis.makeCard = makeCard;
  globalThis.handNotation = handNotation;
  globalThis.topPercentRange = topPercentRange;
  globalThis.seatToPosition = seatToPosition;
  globalThis.isInRange = isInRange;
  globalThis.combosOf = combosOf;
  globalThis.adjustRangeForPersona = adjustRangeForPersona;
`);

const M = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const P = s => s.trim().split(/\s+/).map(t => {
  const su = t.slice(-1), r = t.slice(0, -1);
  return makeCard(M[r] || Number(r), su);
});

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`); }
};

console.log('\n=== MDF 计算 ===');
// 底池100、下注50 → MDF = 100/150 = 66.7%
check('半池注 MDF≈67%', Math.abs(mdf(100, 50) - 2 / 3) < 0.001, `实际 ${mdf(100, 50).toFixed(4)}`);
check('满池注 MDF=50%', Math.abs(mdf(100, 100) - 0.5) < 0.001, `实际 ${mdf(100, 100)}`);
check('1/4池注 MDF=80%', Math.abs(mdf(100, 25) - 0.8) < 0.001, `实际 ${mdf(100, 25)}`);
check('1/3池注 MDF=75%', Math.abs(mdf(100, 33.33) - 0.75) < 0.01, `实际 ${mdf(100, 33.33).toFixed(4)}`);
check('无下注时 MDF=1', mdf(100, 0) === 1);
// 速查表与公式必须一致
let tableOk = true, tableDetail = '';
for (const row of MDF_TABLE) {
  const computed = mdf(1, row.ratio);
  if (Math.abs(computed - row.mdf) > 0.011) {
    tableOk = false;
    tableDetail += `${row.label}: 表${row.mdf} vs 算${computed.toFixed(3)}; `;
  }
}
check('速查表与公式一致', tableOk, tableDetail);

console.log('\n=== 诈唬承接赔率 ===');
// 底池100 下注50：需要 50/(100+100)=25% 胜率
check('半池注需25%胜率', Math.abs(bluffCatchEquity(100, 50) - 0.25) < 0.001,
  `实际 ${bluffCatchEquity(100, 50).toFixed(4)}`);
check('满池注需33%胜率', Math.abs(bluffCatchEquity(100, 100) - 1 / 3) < 0.001,
  `实际 ${bluffCatchEquity(100, 100).toFixed(4)}`);
// MDF 与承接赔率互补关系：MDF = 1 - bluffCatch*... 验证方向
check('注越大承接门槛越高',
  bluffCatchEquity(100, 100) > bluffCatchEquity(100, 50));
check('注越大 MDF 越低', mdf(100, 100) < mdf(100, 50));

console.log('\n=== 牌面 5 分类 ===');
const cases = [
  ['As Kh 7d', 'dryHigh',   '干燥高牌面（彩虹A高）'],
  ['Ah Kh 2h', 'wetFlush',  '三同花面'],
  ['8s 8h 3d', 'paired',    '成对面'],
  ['7s 8h 9d', 'straighty', '顺子面（彩虹连张）'],
  ['2s 5h 9d', 'rainbow',   '彩虹安全面'],
  ['Kh Qh 3d', 'dryHigh',   '两张同色+高张'],
  // 两同色只是同花听牌，三连张是成型顺子威胁，归 straighty 比 wetFlush 更准
  ['9s 8s 7d', 'straighty', '两同色+三连张（顺子威胁主导）'],
  ['9h 8h 7h', 'wetFlush',  '三同花+连张（同花已成威胁）'],
  ['Kd Kh Qs', 'paired',    '成对优先于高牌']
];
for (const [b, want, desc] of cases) {
  const got = classifyBoard(P(b));
  check(`${desc}: ${b}`, got.key === want, `期望 ${want}，实际 ${got.key}（${got.label}）`);
}
// 每类都要有完整策略字段
let fieldsOk = true;
for (const b of cases) {
  const c = classifyBoard(P(b[0]));
  if (typeof c.cbetFreq !== 'number' || typeof c.size !== 'number' || !c.sizeLabel || !c.note) {
    fieldsOk = false;
  }
}
check('分类均带完整策略字段', fieldsOk);
// 湿面尺度应大于成对面
check('湿面尺度>成对面尺度',
  classifyBoard(P('Ah Kh 2h')).size > classifyBoard(P('8s 8h 3d')).size);
check('不足3张牌时有兜底', classifyBoard([]).key === 'rainbow');

console.log('\n=== SPR 分档 ===');
check('SPR<1 为极短', sprBucket(50, 100).key === 'short', `实际 ${sprBucket(50, 100).key}`);
check('SPR=3 为中短', sprBucket(300, 100).key === 'midlow', `实际 ${sprBucket(300, 100).key}`);
check('SPR=7 为中等', sprBucket(700, 100).key === 'mid', `实际 ${sprBucket(700, 100).key}`);
check('SPR=20 为深', sprBucket(2000, 100).key === 'deep', `实际 ${sprBucket(2000, 100).key}`);
check('底池为0时不崩', sprBucket(1000, 0).key === 'deep');
check('SPR 数值正确', Math.abs(sprBucket(300, 100).spr - 3) < 0.001);

console.log('\n=== 河牌极化 ===');
check('坚果→价值下注', riverRole('nuts', false) === 'value');
check('强牌→价值下注', riverRole('strong', false) === 'value');
check('空气+阻断→诈唬', riverRole('air', true) === 'bluff');
check('空气无阻断→放弃', riverRole('air', false) === 'giveup');
check('中等牌→过牌（极化核心）', riverRole('medium', false) === 'giveup');
check('中等牌即使有阻断也过牌', riverRole('medium', true) === 'giveup');

console.log('\n=== 翻前记号与范围 ===');
check('对子记号', handNotation(P('As Ah')) === 'AA', handNotation(P('As Ah')));
check('同花记号', handNotation(P('As Ks')) === 'AKs', handNotation(P('As Ks')));
check('不同花记号', handNotation(P('As Kh')) === 'AKo', handNotation(P('As Kh')));
check('低牌记号顺序', handNotation(P('2s 7h')) === '72o', handNotation(P('2s 7h')));
check('组合数：对子6', combosOf('AA') === 6);
check('组合数：同花4', combosOf('AKs') === 4);
check('组合数：不同花12', combosOf('AKo') === 12);

console.log('\n=== 位置范围收紧方向 ===');
const utg = topPercentRange(15), btn = topPercentRange(43);
check('BTN范围比UTG宽', btn.size > utg.size, `BTN ${btn.size} vs UTG ${utg.size}`);
check('AA在所有范围内', utg.has('AA') && btn.has('AA'));
check('72o不在UTG范围', !utg.has('72o'));
check('UTG范围是BTN子集', [...utg].every(h => btn.has(h)),
  `UTG独有: ${[...utg].filter(h => !btn.has(h)).join(' ')}`);
check('AA在UTG开池范围', isInRange(P('As Ah'), 'UTG', 'open'));
check('72o不在UTG开池范围', !isInRange(P('7s 2h'), 'UTG', 'open'));
check('BB开池率为0（只防守）', !isInRange(P('As Ah'), 'BB', 'open'));

console.log('\n=== 性格调制 ===');
check('松手范围更宽', adjustRangeForPersona(27, 'loose', 'open') > 27);
check('紧手范围更窄', adjustRangeForPersona(27, 'tight', 'open') < 27);
check('跟注站跟注范围宽', adjustRangeForPersona(22, 'station', 'call') > 22);
check('跟注站开池不宽', adjustRangeForPersona(27, 'station', 'open') < 27);
check('调制有上下限', adjustRangeForPersona(5, 'tight', 'open') >= 5
  && adjustRangeForPersona(50, 'loose', 'open') <= 55);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
