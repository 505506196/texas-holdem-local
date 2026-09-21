// 复盘规则引擎测试：构造文档里的典型场景，验证建议符合战术原则
const fs = require('fs');
const path = require('path');

global.window = {};
global.setTimeout = fn => { fn(); return 0; };

const src = ['cards.js', 'game.js', 'ai.js', 'review.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8')).join('\n');
eval(src + `
  globalThis.reviewDecision = reviewDecision;
  globalThis.applyTactics = applyTactics;
  globalThis.boardTexture = boardTexture;
  globalThis.classifyHand = classifyHand;
  globalThis.myDraws = myDraws;
  globalThis.makeCard = makeCard;
  globalThis.RANK_LABEL = RANK_LABEL;
`);

const M = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
const P = str => str.trim().split(/\s+/).map(tok => {
  const suit = tok.slice(-1);
  const r = tok.slice(0, -1);
  return makeCard(M[r] || Number(r), suit);
});

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`); }
}

// 构造一个决策快照
function snap(o) {
  return {
    playerId: 0,
    street: o.street || 'flop',
    potBefore: o.pot != null ? o.pot : 100,
    toCall: o.toCall || 0,
    hole: P(o.hole),
    board: o.board ? P(o.board) : [],
    position: o.position || '按钮位',
    action: o.action,
    betAfter: o.betAfter || 0,
    legal: o.legal || [{ type: 'fold' }, { type: 'call' }, { type: 'raise', min: 1, max: 999 }],
    liveOpponentIds: o.oppIds || [1],
    isPreflopAggressor: o.isPFA !== false,
    facingBet: (o.toCall || 0) > 0
  };
}

// 对手历史：用于范围推断与线路分析
function hist(entries) {
  return entries.map(e => ({
    playerId: e.id, street: e.street, action: e.action
  }));
}

console.log('\n=== 牌面纹理识别 ===');
const dry = boardTexture(P('Ac Td 7s'));
const wet = boardTexture(P('9s 8s 7d'));      // 连张 + 两张同色
const veryWet = boardTexture(P('9s 8s 7s'));  // 连张 + 三张同色
const flushy = boardTexture(P('Kh Qh 3h'));
const paired = boardTexture(P('8c 8d 6d'));
check('干燥牌面 wet<0.35', dry.wet < 0.35, `实际 ${dry.wet.toFixed(2)}`);
// 两张同色的连张面属中性偏湿；三同色连张面才是真正的极湿
check('连张两色 wet>0.4', wet.wet > 0.4, `实际 ${wet.wet.toFixed(2)}`);
check('连张三同色 wet>0.7', veryWet.wet > 0.7, `实际 ${veryWet.wet.toFixed(2)}`);
check('三同色比两同色更湿', veryWet.wet > wet.wet);
check('三同花识别 flushDraw', flushy.flushDraw === true);
check('公对识别 paired', paired.paired === true);
check('有A识别 hasAce', dry.hasAce === true);

console.log('\n=== 牌力分档 ===');
const kkOnAce = classifyHand(P('Kh Kc'), P('Ac Td 7s'));
const topPairTop = classifyHand(P('Ah Kd'), P('Ac 8d 3s'));
const boardPair = classifyHand(P('7h 6d'), P('Kc Kd 3s'));
const setHand = classifyHand(P('8h 8d'), P('8c Kd 3s'));
check('KK在A面=超对但capped', kkOnAce.capped === true, `tier=${kkOnAce.tier} label=${kkOnAce.label}`);
check('顶对大踢脚不capped', topPairTop.capped === false, `label=${topPairTop.label}`);
check('公共牌对子标记capped', boardPair.capped === true, `label=${boardPair.label}`);
check('暗三条识别为strong', setHand.tier === 'strong' && /暗三条/.test(setHand.label), `label=${setHand.label}`);

console.log('\n=== 听牌与阻断牌 ===');
const fd = myDraws(P('Ah 5h'), P('Kh 8h 2c'));
const oe = myDraws(P('9c 8d'), P('7s 6h Kd'));
// 阻断牌只在牌面已有 3 张同色（对手可能已听/已成花）时才有意义，
// 牌面仅 2 张同色时我持 Ah 不构成「坚果同花阻断」
const blockerOn3 = myDraws(P('Ah 5h'), P('Kh 8h 2h'));
check('同花听牌 9 outs', fd.outs >= 9, `outs=${fd.outs}`);
check('牌面仅2同色时不算阻断', fd.nutFlushBlocker === false);
check('牌面3同色且持A同色=坚果阻断', blockerOn3.nutFlushBlocker === true,
  `实际 ${blockerOn3.nutFlushBlocker}`);
check('两头顺 8 outs', oe.outs >= 8, `outs=${oe.outs} label=${oe.label}`);

console.log('\n=== 战术规则：被动方不要 donk bet ===');
// 我是翻前被动方，翻牌圈率先下注
let r = reviewDecision(
  snap({ hole: 'Kh Jd', board: '4c Th 9s', action: 'bet', betAfter: 50, isPFA: false,
         toCall: 0, pot: 100 }),
  hist([{ id: 1, street: 'preflop', action: 'raise' }])
);
check('被动方下注被判为不建议', r.advice === 'check', `建议=${r.adviceLabel} 规则=${r.ruleId}`);
check('命中 no-donk-bet 规则', r.ruleId === 'no-donk-bet', `实际 ${r.ruleId}`);

console.log('\n=== 战术规则：牌面有A时KK不价值下注 ===');
r = reviewDecision(
  snap({ hole: 'Kh Kc', board: 'Ac Td 7s', action: 'bet', betAfter: 50, toCall: 0, pot: 100 }),
  hist([{ id: 1, street: 'preflop', action: 'call' }])
);
check('KK在A面建议过牌', r.advice === 'check', `建议=${r.adviceLabel} 规则=${r.ruleId} 牌力=${r.handLabel}`);

console.log('\n=== 战术规则：对手翻牌跟注后转牌别开第二枪 ===');
r = reviewDecision(
  snap({ hole: 'Kh Kc', board: '4h 4c Ad 5s', street: 'turn', action: 'bet',
         betAfter: 60, toCall: 0, pot: 150 }),
  hist([
    { id: 1, street: 'preflop', action: 'call' },
    { id: 1, street: 'flop', action: 'call' }
  ])
);
check('转牌建议过牌控池', r.advice === 'check', `建议=${r.adviceLabel} 规则=${r.ruleId}`);

console.log('\n=== 战术规则：对手连续过牌该薄价值/诈唬 ===');
r = reviewDecision(
  snap({ hole: 'Ah Kd', board: '7c Ac Jc 4s 8h', street: 'river', action: 'check',
         toCall: 0, pot: 120 }),
  hist([
    { id: 1, street: 'preflop', action: 'call' },
    { id: 1, street: 'flop', action: 'check' },
    { id: 1, street: 'turn', action: 'check' },
    { id: 1, street: 'river', action: 'check' }
  ])
);
check('对手连续过牌时建议下注', r.advice === 'bet', `建议=${r.adviceLabel} 规则=${r.ruleId}`);

console.log('\n=== 战术规则：干燥牌面多人底池不半诈唬 ===');
r = reviewDecision(
  snap({ hole: 'Ad Kh', board: '4s 2d 8d', action: 'bet', betAfter: 40, toCall: 0,
         pot: 100, oppIds: [1, 2] }),
  hist([{ id: 1, street: 'preflop', action: 'call' }, { id: 2, street: 'preflop', action: 'call' }])
);
check('多人干燥面不建议半诈唬', r.advice === 'check', `建议=${r.adviceLabel} 规则=${r.ruleId}`);

console.log('\n=== 战术规则：面对小注不要过度弃牌 ===');
r = reviewDecision(
  snap({ hole: 'Ah Kc', board: '4s 2d 8d', action: 'fold', toCall: 10, pot: 100 }),
  hist([{ id: 1, street: 'preflop', action: 'call' }, { id: 1, street: 'flop', action: 'bet' }])
);
check('小注面前弃牌被纠正为跟注', r.advice === 'call', `建议=${r.adviceLabel} 规则=${r.ruleId}`);

console.log('\n=== 战术规则：连续下注后非坚果不加注 ===');
r = reviewDecision(
  snap({ hole: 'Ah Kd', board: 'Kc 8d 3s 6h 2c', street: 'river', action: 'raise',
         betAfter: 200, toCall: 60, pot: 200 }),
  hist([
    { id: 1, street: 'flop', action: 'bet' },
    { id: 1, street: 'turn', action: 'bet' },
    { id: 1, street: 'river', action: 'bet' }
  ])
);
check('对手极化范围时不建议加注', r.advice !== 'raise', `建议=${r.adviceLabel} 规则=${r.ruleId}`);

console.log('\n=== EV 计算正确性 ===');
// 底池100 跟注50：门槛应为 50/150 = 33.3%
r = reviewDecision(
  snap({ hole: '2c 3d', board: 'Kh Qs Js', action: 'call', toCall: 50, pot: 100 }),
  hist([{ id: 1, street: 'flop', action: 'bet' }])
);
check('底池赔率门槛 = toCall/(pot+toCall)', Math.abs(r.needEquity - 50 / 150) < 0.001,
  `实际 ${r.needEquity.toFixed(4)}，期望 ${(50 / 150).toFixed(4)}`);
const expectEV = r.equity * 150 - 50;
check('callEV = equity*(pot+toCall)-toCall', Math.abs(r.callEV - expectEV) < 0.01,
  `实际 ${r.callEV.toFixed(2)}，期望 ${expectEV.toFixed(2)}`);
check('弱牌高门槛时判为漏洞', r.grade === 'leak' || r.advice === 'fold',
  `grade=${r.grade} advice=${r.advice} equity=${(r.equity * 100).toFixed(1)}%`);

console.log('\n=== 范围收紧确实降低胜率 ===');
// 同一手牌，对手从被动范围换成多次加注的强范围，胜率应下降
const weakHole = P('7c 2d');
const board3 = P('Kh 9s 4d');
const vsPassive = rangeEquity(weakHole, board3, ['passive'], 4000).equity;
const vsAggro = rangeEquity(weakHole, board3, ['aggressor'], 4000).equity;
console.log(`  72o vs 宽范围=${(vsPassive * 100).toFixed(1)}%  vs 强范围=${(vsAggro * 100).toFixed(1)}%`);
check('对强范围胜率显著更低', vsAggro < vsPassive - 0.03,
  `passive=${vsPassive.toFixed(3)} aggressor=${vsAggro.toFixed(3)}`);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
