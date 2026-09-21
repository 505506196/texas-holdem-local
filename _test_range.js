// 范围模型准确度测试：验证牌面感知范围比 Chen 分硬筛更贴近实战
const fs = require('fs');
const path = require('path');

global.window = {};
global.setTimeout = fn => { fn(); return 0; };

const src = ['cards.js', 'game.js', 'ai.js', 'range.js', 'review.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8')).join('\n');
eval(src + `
  globalThis.buildWeightedRange = buildWeightedRange;
  globalThis.comboStrength = comboStrength;
  globalThis.describeRange = describeRange;
  globalThis.sampleFromRange = sampleFromRange;
  globalThis.weightedEquity = weightedEquity;
  globalThis.rangeEquity = rangeEquity;
  globalThis.buildEvTable = buildEvTable;
  globalThis.estimateFoldRate = estimateFoldRate;
  globalThis.boardTexture = boardTexture;
  globalThis.makeCard = makeCard;
  globalThis.STR = STR;
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

const H = entries => entries.map(e => ({
  playerId: e.id, street: e.street, action: e.action, betRatio: e.betRatio || 0
}));

console.log('\n=== 组合强度评估 ===');
const board = P('9s 8s 7d');
check('暗三条=SET档', comboStrength(P('9h 9c'), board).tier === STR.SET);
check('两对档位正确', comboStrength(P('9h 8c'), board).tier === STR.TWO_PAIR);
check('顺子归入顺/花档', comboStrength(P('Ts Jh'), board).tier === STR.STRAIGHT_FLUSH_CLASS,
  `实际 ${comboStrength(P('Ts Jh'), board).tier}`);
check('同花听牌提档为强听', comboStrength(P('As 2s'), board).tier === STR.STRONG_DRAW,
  `实际 ${comboStrength(P('As 2s'), board).tier}`);
check('无关小牌=空气', comboStrength(P('2c 3h'), board).tier === STR.AIR,
  `实际 ${comboStrength(P('2c 3h'), board).tier}`);
check('河牌圈听牌不再计分', comboStrength(P('As 2s'), P('9s 8s 7d 2h 3c')).outs === 0);

console.log('\n=== 范围随动作收紧 ===');
const dead = P('Ah Kh').concat(board);
// 只过牌的对手 vs 连续加注的对手
const rPassive = buildWeightedRange(1, H([
  { id: 1, street: 'preflop', action: 'call' },
  { id: 1, street: 'flop', action: 'check' }
]), board, dead);
const rAggro = buildWeightedRange(1, H([
  { id: 1, street: 'preflop', action: 'raise' },
  { id: 1, street: 'flop', action: 'raise', betRatio: 0.8 }
]), board, dead);

const strongShare = r => {
  const t = r.tierCount, sum = t.reduce((a, b) => a + b, 0);
  return sum > 0 ? (t[STR.TWO_PAIR] + t[STR.SET] + t[STR.STRAIGHT_FLUSH_CLASS] + t[STR.MONSTER]) / sum : 0;
};
const airShare = r => {
  const t = r.tierCount, sum = t.reduce((a, b) => a + b, 0);
  return sum > 0 ? t[STR.AIR] / sum : 0;
};

console.log(`  过牌方: ${describeRange(rPassive)}`);
console.log(`  加注方: ${describeRange(rAggro)}`);
check('加注范围强牌占比更高', strongShare(rAggro) > strongShare(rPassive),
  `加注 ${(strongShare(rAggro) * 100).toFixed(1)}% vs 过牌 ${(strongShare(rPassive) * 100).toFixed(1)}%`);
check('过牌范围空气占比更高', airShare(rPassive) > airShare(rAggro),
  `过牌 ${(airShare(rPassive) * 100).toFixed(1)}% vs 加注 ${(airShare(rAggro) * 100).toFixed(1)}%`);

console.log('\n=== 牌面感知 vs Chen分硬筛：关键差异 ===');
// 场景：干燥牌面 Kh7c2d，对手连续下注。
// Chen 分模型只看起手牌强度，无法知道「他在这个面上下注意味着有 K 或更好」
const dryBoard = P('Kh 7c 2d');
const myHand = P('Qs Jd');   // 两高张未成牌
const histBet = H([
  { id: 1, street: 'preflop', action: 'raise' },
  { id: 1, street: 'flop', action: 'bet', betRatio: 0.7 }
]);

const eqWeighted = weightedEquity(myHand, dryBoard, [1], histBet, 6000);
const eqChen = rangeEquity(myHand, dryBoard, ['raiser'], 6000);
console.log(`  QJ on Kh7c2d 面对下注：牌面感知=${(eqWeighted.equity * 100).toFixed(1)}%`
  + `  Chen硬筛=${(eqChen.equity * 100).toFixed(1)}%`);
check('牌面感知给出更低（更真实）的胜率', eqWeighted.equity < eqChen.equity,
  `weighted=${eqWeighted.equity.toFixed(3)} chen=${eqChen.equity.toFixed(3)}`);
check('未触发回退', eqWeighted.fallback !== true);
check('有效样本数充足', (eqWeighted.samples || 0) > 4000, `samples=${eqWeighted.samples}`);

console.log('\n=== 对手过牌时胜率应回升 ===');
const histCheck = H([
  { id: 1, street: 'preflop', action: 'call' },
  { id: 1, street: 'flop', action: 'check' }
]);
const eqVsCheck = weightedEquity(myHand, dryBoard, [1], histCheck, 6000);
console.log(`  QJ 面对过牌=${(eqVsCheck.equity * 100).toFixed(1)}%  面对下注=${(eqWeighted.equity * 100).toFixed(1)}%`);
check('对手示弱时我方胜率更高', eqVsCheck.equity > eqWeighted.equity,
  `check=${eqVsCheck.equity.toFixed(3)} bet=${eqWeighted.equity.toFixed(3)}`);

console.log('\n=== 下注尺度影响范围极化 ===');
const rBig = buildWeightedRange(1, H([
  { id: 1, street: 'flop', action: 'bet', betRatio: 1.2 }
]), board, dead);
const rSmall = buildWeightedRange(1, H([
  { id: 1, street: 'flop', action: 'bet', betRatio: 0.25 }
]), board, dead);
const midShare = r => {
  const t = r.tierCount, sum = t.reduce((a, b) => a + b, 0);
  return sum > 0 ? (t[STR.WEAK_PAIR] + t[STR.TOP_PAIR]) / sum : 0;
};
console.log(`  大注: ${describeRange(rBig)}`);
console.log(`  小注: ${describeRange(rSmall)}`);
check('小注范围中等成牌占比更高', midShare(rSmall) > midShare(rBig),
  `小注 ${(midShare(rSmall) * 100).toFixed(1)}% vs 大注 ${(midShare(rBig) * 100).toFixed(1)}%`);

console.log('\n=== 多动作 EV 表 ===');
const tex = boardTexture(dryBoard);
const ev = buildEvTable({
  equity: 0.55, effectiveEquity: 0.58, pot: 100, toCall: 50,
  canRaise: true, texture: tex, draws: { has: false, outs: 0 },
  oppRange: rAggro
});
console.log('  ' + ev.rows.map(r => `${r.label}:${r.ev.toFixed(1)}`).join('  '));
check('弃牌EV恒为0', ev.rows.find(r => r.action === 'fold').ev === 0);
const callRow = ev.rows.find(r => r.action === 'call');
check('跟注EV=equity*(pot+toCall)-toCall',
  Math.abs(callRow.ev - (0.55 * 150 - 50)) < 0.01,
  `实际 ${callRow.ev.toFixed(2)} 期望 ${(0.55 * 150 - 50).toFixed(2)}`);
check('标出最优动作', ev.rows.filter(r => r.isBest).length === 1);
check('最优动作EV最高', ev.rows.every(r => r.ev <= ev.bestEV + 1e-9));

// 弱牌高门槛时弃牌应是最优
const evWeak = buildEvTable({
  equity: 0.12, effectiveEquity: 0.12, pot: 100, toCall: 90,
  canRaise: false, texture: tex, draws: { has: false, outs: 0 }, oppRange: rAggro
});
check('弱牌面对大注时弃牌最优', evWeak.bestAction === 'fold',
  `实际 ${evWeak.bestAction}，各项 ${evWeak.rows.map(r => r.label + '=' + r.ev.toFixed(1)).join(', ')}`);

console.log('\n=== 弃牌率估算 ===');
const frAggro = estimateFoldRate(rAggro, tex);
const frPassive = estimateFoldRate(rPassive, tex);
console.log(`  加注方弃牌率=${(frAggro * 100).toFixed(1)}%  过牌方弃牌率=${(frPassive * 100).toFixed(1)}%`);
check('过牌方（范围弱）弃牌率更高', frPassive > frAggro,
  `passive=${frPassive.toFixed(3)} aggro=${frAggro.toFixed(3)}`);
check('弃牌率在合理区间', frAggro >= 0.05 && frPassive <= 0.8);

console.log('\n=== 抽样不产生冲突牌 ===');
let conflicts = 0;
for (let i = 0; i < 400; i++) {
  const used = new Set(dead.map(c => c.rank + c.suit));
  const h = sampleFromRange(rAggro, used);
  if (!h) continue;
  if (used.has(h[0].rank + h[0].suit) || used.has(h[1].rank + h[1].suit)) conflicts++;
  if (h[0].rank === h[1].rank && h[0].suit === h[1].suit) conflicts++;
}
check('抽样不与已用牌冲突', conflicts === 0, `冲突 ${conflicts} 次`);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
