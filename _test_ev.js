// EV 表口径一致性测试：验证各动作可直接比较、弱牌不会被误判为该下注
const fs = require('fs');
const path = require('path');

global.window = {};
global.setTimeout = fn => { fn(); return 0; };

const src = ['cards.js', 'preflop.js', 'strategy.js', 'game.js', 'ai.js', 'range.js', 'review.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8')).join('\n');
eval(src + `
  globalThis.buildEvTable = buildEvTable;
  globalThis.estimateFoldRate = estimateFoldRate;
  globalThis.boardTexture = boardTexture;
  globalThis.buildWeightedRange = buildWeightedRange;
  globalThis.makeCard = makeCard;
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
const show = t => t.rows.map(r => `${r.label}=${r.ev.toFixed(1)}${r.isBest ? '*' : ''}`).join('  ');

const dryTex = boardTexture(P('Kh 7c 2d'));
const wetTex = boardTexture(P('9s 8s 7s'));

console.log('\n=== 河牌圈诈唬：弃牌率决定该不该下注 ===');
// 对手范围里有 36% 空气 ⇒ 弃牌率约 45%，高于半池诈唬所需的 33.3% ⇒ 诈唬 +EV
const airRiver = buildEvTable({
  equity: 0.11, effectiveEquity: 0.11, pot: 132, toCall: 0,
  canRaise: true, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: { tierCount: [36, 0, 57, 0, 0, 4, 3, 0, 0] }   // 对子多、空气36%
});
console.log('  ' + show(airRiver));
// 半池注需要 66/(132+66)=33.3% 弃牌率才盈亏平衡；这里约 45%，故诈唬 +EV 是正确结论
check('对手多空气时诈唬为正EV',
  airRiver.rows.find(r => r.action === 'bet').ev > 0);
// 只有 tierCount 没有 combos 时，无法派生子范围，应走估算回退
check('缺少combos时回退到估算', airRiver.rows.find(r => r.action === 'bet').method === 'estimate',
  `实际 ${airRiver.rows.find(r => r.action === 'bet').method}`);
check('回退路径标注为估算',
  /估算/.test(airRiver.rows.find(r => r.action === 'bet').note));

console.log('\n=== eqCalled 真算路径（用真实范围） ===');
// 用 buildWeightedRange 造真实范围，此时应走真算而非估算
const realBoard = P('Kh 7c 2d');
const myHole = P('Ah Qd');
const realRange = buildWeightedRange(1,
  [{ playerId: 1, street: 'preflop', action: 'raise', betRatio: 0 },
   { playerId: 1, street: 'flop', action: 'bet', betRatio: 0.6 }],
  realBoard, myHole.concat(realBoard));
const realEv = buildEvTable({
  equity: 0.45, effectiveEquity: 0.45, pot: 100, toCall: 0,
  canRaise: true, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: realRange, hole: myHole, board: realBoard
});
const realBet = realEv.rows.find(r => r.action === 'bet');
console.log('  ' + show(realEv));
console.log('  ' + realBet.note);
check('有真实范围时走真算', realBet.method === 'real', `实际 ${realBet.method}`);
check('真算路径标注为实测', /实测/.test(realBet.note));
// 真算的核心价值：被跟注后胜率确实低于对抗全范围
const eqCalledPct = parseFloat(realBet.note.match(/实测 ([\d.]+)%/)?.[1] || '99');
check('被跟注时胜率低于全范围胜率', eqCalledPct < 45,
  `eqCalled=${eqCalledPct}% vs 全范围 45%`);

// 反向用例：对手范围几乎没有空气 ⇒ 打不走人 ⇒ 诈唬必须是负EV
const noFoldRiver = buildEvTable({
  equity: 0.11, effectiveEquity: 0.11, pot: 132, toCall: 0,
  canRaise: true, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: { tierCount: [0, 0, 5, 0, 35, 30, 30, 0, 0] }   // 全是成牌，无空气
});
console.log('  ' + show(noFoldRiver));
check('对手无空气时诈唬为负EV',
  noFoldRiver.rows.find(r => r.action === 'bet').ev < 0,
  `实际 ${noFoldRiver.rows.find(r => r.action === 'bet').ev.toFixed(1)}`);
check('对手无空气时过牌最优', noFoldRiver.bestAction === 'check',
  `实际 ${noFoldRiver.bestAction}`);

console.log('\n=== 强牌下注应优于过牌 ===');
const strongBet = buildEvTable({
  equity: 0.82, effectiveEquity: 0.82, pot: 100, toCall: 0,
  canRaise: true, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: { tierCount: [30, 10, 40, 5, 10, 3, 2, 0, 0] }
});
console.log('  ' + show(strongBet));
check('82%胜率时下注优于过牌',
  strongBet.rows.find(r => r.action === 'bet').ev >
  strongBet.rows.find(r => r.action === 'check').ev);

console.log('\n=== 口径一致：无投入动作的EV等于胜率×底池 ===');
check('过牌EV = equity × pot',
  Math.abs(strongBet.rows.find(r => r.action === 'check').ev - 0.82 * 100) < 0.01,
  `实际 ${strongBet.rows.find(r => r.action === 'check').ev.toFixed(2)}`);

console.log('\n=== 跟注公式 ===');
const callCase = buildEvTable({
  equity: 0.55, effectiveEquity: 0.55, pot: 100, toCall: 50,
  canRaise: true, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: { tierCount: [20, 10, 30, 10, 20, 5, 5, 0, 0] }
});
console.log('  ' + show(callCase));
check('跟注EV = equity×(pot+toCall) − toCall',
  Math.abs(callCase.rows.find(r => r.action === 'call').ev - (0.55 * 150 - 50)) < 0.01,
  `实际 ${callCase.rows.find(r => r.action === 'call').ev.toFixed(2)}`);

console.log('\n=== 加注底池不应重复计入下注额 ===');
// 底池100 需跟50 加注75：对手跟注后最终底池应是 100+50+75*2 = 300
const raiseCase = buildEvTable({
  equity: 0.5, effectiveEquity: 0.5, pot: 100, toCall: 50,
  canRaise: true, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: { tierCount: [0, 0, 100, 0, 0, 0, 0, 0, 0] }   // 全是弱对子，弃牌率25%
});
const rr = raiseCase.rows.find(r => r.action === 'raise');
const rng2 = { tierCount: [0, 0, 100, 0, 0, 0, 0, 0, 0] };
const betSize = Math.max(1, Math.round(150 * 0.5));
const fr = estimateFoldRate(rng2, dryTex, betSize / 150);
// 被跟注时对手范围收紧：用有界折减（早先的反解公式在低胜率时会坍塌到下限）
const eqFull = 0.5;
const shrink = 0.55 + 0.35 * (1 - fr);
const eqCalled = Math.max(0.02, Math.min(eqFull, eqFull * shrink));
const finalPot = 100 + 50 + betSize * 2;
const expected = fr * 150 + (1 - fr) * (eqCalled * finalPot - (50 + betSize));
console.log(`  加注EV=${rr.ev.toFixed(2)} 期望=${expected.toFixed(2)}`
  + ` (betSize=${betSize}, foldRate=${(fr*100).toFixed(1)}%, eqCalled=${(eqCalled*100).toFixed(1)}%)`);
check('加注EV与手算一致（含范围收紧）', Math.abs(rr.ev - expected) < 0.01,
  `实际 ${rr.ev.toFixed(2)} 期望 ${expected.toFixed(2)}`);

console.log('\n=== 弃牌恒为0且弱牌时为最优 ===');
const hopeless = buildEvTable({
  equity: 0.08, effectiveEquity: 0.08, pot: 100, toCall: 95,
  canRaise: false, texture: dryTex, draws: { has: false, outs: 0 },
  oppRange: { tierCount: [5, 5, 20, 10, 30, 15, 15, 0, 0] }
});
console.log('  ' + show(hopeless));
check('弃牌EV恒为0', hopeless.rows.find(r => r.action === 'fold').ev === 0);
check('8%胜率面对大注时弃牌最优', hopeless.bestAction === 'fold', `实际 ${hopeless.bestAction}`);

console.log('\n=== 潮湿牌面弃牌率更低 ===');
const rng = { tierCount: [40, 20, 20, 10, 5, 3, 2, 0, 0] };
const frDry = estimateFoldRate(rng, dryTex);
const frWet = estimateFoldRate(rng, wetTex);
console.log(`  干燥=${(frDry*100).toFixed(1)}%  潮湿=${(frWet*100).toFixed(1)}%`);
check('潮湿牌面对手更少弃牌', frWet < frDry, `wet=${frWet.toFixed(3)} dry=${frDry.toFixed(3)}`);

console.log('\n=== 听牌的隐含赔率应提升下注EV ===');
const noDraw = buildEvTable({
  equity: 0.35, effectiveEquity: 0.35, pot: 100, toCall: 0,
  canRaise: true, texture: wetTex, draws: { has: false, outs: 0 },
  oppRange: rng
});
const withDraw = buildEvTable({
  equity: 0.35, effectiveEquity: 0.52, pot: 100, toCall: 0,
  canRaise: true, texture: wetTex, draws: { has: true, outs: 9 },
  oppRange: rng
});
check('有效胜率更高时下注EV更高',
  withDraw.rows.find(r => r.action === 'bet').ev >
  noDraw.rows.find(r => r.action === 'bet').ev);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
