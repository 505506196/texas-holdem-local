// 大盲前注测试：验证前注金额、不计入跟注额、随涨盲翻倍、作为死钱归主池、筹码守恒
const fs = require('fs');
const path = require('path');

global.window = {};
let pending = [];
global.setTimeout = fn => { pending.push(fn); return 0; };

const src = ['cards.js', 'preflop.js', 'strategy.js', 'game.js', 'ai.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8')).join('\n');
eval(src + `
  globalThis.Game = Game;
  globalThis.decideAction = decideAction;
  globalThis.makeCard = makeCard;
`);

const drain = () => { let g = 0; while (pending.length) { if (++g > 5000) break; pending.shift()(); } };

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`); }
};

function mkGame(opts = {}) {
  return new Game({
    players: [{ name: '我' }, { name: 'A' }, { name: 'B' }],
    smallBlind: 10, bigBlind: 20, startStack: opts.stack || 100000,
    blindInterval: opts.blindInterval != null ? opts.blindInterval : 0,
    anteMultiple: opts.anteMultiple,
    onEvent: () => {}
  });
}

console.log('\n=== 前注金额与底池 ===');
const g1 = mkGame();
g1.startHand();
check('默认收 1 倍大盲的前注', g1.ante === 20, `实际 ${g1.ante}`);
check('翻前底池 = 小盲 + 大盲 + 前注 = 50', g1.pot === 50, `实际 ${g1.pot}`);
check('前注记为死钱', g1.deadAnte === 20, `实际 ${g1.deadAnte}`);

const gBB = g1.players[g1.bbIndex];
check('大盲的本轮下注额仍是 20（前注不计入 bet）', gBB.bet === 20, `实际 ${gBB.bet}`);
check('大盲的本手总投入是 40（含前注）', gBB.totalBet === 40, `实际 ${gBB.totalBet}`);
check('当前注额是大盲而非大盲+前注', g1.currentBet === 20, `实际 ${g1.currentBet}`);

const utg = g1.actingIndex;
const callAct = g1.legalActions(utg).find(a => a.type === 'call');
check('别人只需跟 20，不用跟前注', callAct && callAct.amount === 20,
  `实际 ${callAct && callAct.amount}`);

console.log('\n=== 倍数与关闭 ===');
const g2 = mkGame({ anteMultiple: 2 });
g2.startHand();
check('2 倍前注 = 40', g2.ante === 40, `实际 ${g2.ante}`);
check('2 倍时底池 = 10+20+40 = 70', g2.pot === 70, `实际 ${g2.pot}`);

const g0 = mkGame({ anteMultiple: 0 });
g0.startHand();
check('关闭后无前注', g0.ante === 0 && g0.deadAnte === 0, `ante=${g0.ante}`);
check('关闭后底池 = 30', g0.pot === 30, `实际 ${g0.pot}`);

console.log('\n=== 前注随涨盲翻倍 ===');
const g3 = mkGame({ blindInterval: 2 });
g3.startHand(); g3.handOver = true;
const ante1 = g3.ante;
g3.startHand(); g3.handOver = true;
g3.startHand();
check('第 1 手前注 20', ante1 === 20, `实际 ${ante1}`);
check('第 3 手大盲翻倍后前注同步到 40', g3.ante === 40, `实际 ${g3.ante}`);
check('第 3 手底池 = 20+40+40 = 100', g3.pot === 100, `实际 ${g3.pot}`);

console.log('\n=== 前注是死钱：大盲不能靠分层拿回 ===');
// 三人全部 limp 到 20 后摊牌平分：若前注被当成大盲的个人投入，
// 分层会多切一个只有大盲够格的边池，把 20 原样退还给他
function limpSplit() {
  const g = mkGame({ stack: 1000 });
  g.startHand();
  for (const p of g.players) { p.folded = false; p.allIn = false; }
  // 三人牌力完全相同（公共牌成顺，底牌不参与）
  g.players.forEach((p, i) => {
    p.hole = [makeCard(2, ['s', 'd', 'c'][i]), makeCard(3, ['h', 's', 'd'][i])];
  });
  g.board = [makeCard(9, 's'), makeCard(10, 'h'), makeCard(11, 'd'), makeCard(12, 'c'), makeCard(13, 's')];
  g.street = 'river';
  // 补平到人人 limp 20（大盲已有 20 盲注 + 20 前注 = 40，不再补）
  for (const p of g.players) {
    const need = 20 - (p.totalBet - (p.id === g.bbIndex ? g.deadAnte : 0));
    if (need > 0) { p.stack -= need; p.totalBet += need; g.pot += need; }
    p.bet = 0;
  }
  const potBefore = g.pot;
  const before = g.players.map(p => p.stack);
  g.finishHand();
  const got = g.players.map((p, i) => p.stack - before[i]);
  return { got, potBefore, sum: got.reduce((a, b) => a + b, 0) };
}
const ls = limpSplit();
check('底池 = 3×20 投入 + 20 前注 = 80', ls.potBefore === 80, `实际 ${ls.potBefore}`);
check('全额分出，无蒸发', ls.sum === 80, `合计 ${ls.sum}`);
check('三人均分，前注没退回大盲', ls.got.every(v => v >= 26 && v <= 27),
  `实际 ${ls.got}（若有人拿 40+ 说明前注被当成个人投入退回了）`);

console.log('\n=== 大盲弃牌后前注留在底池 ===');
function bbFolds() {
  const g = mkGame({ stack: 1000 });
  g.startHand();
  const bbi = g.bbIndex;
  // 除大盲外全部弃牌到只剩一人，大盲也弃 —— 先让大盲弃，剩下两人之一拿池
  const potAtStart = g.pot;
  let guard = 0;
  while (!g.handOver && guard++ < 50) {
    const idx = g.actingIndex;
    if (idx < 0) break;
    const acts = g.legalActions(idx);
    // 大盲弃牌，其余人跟注，制造「大盲投入已含前注却出局」的局面
    if (idx === bbi) g.applyAction(idx, 'fold');
    else if (acts.find(a => a.type === 'call')) g.applyAction(idx, 'call');
    else g.applyAction(idx, 'check');
    drain();
  }
  return { g, potAtStart };
}
const bf = bbFolds();
const totalChips = bf.g.players.reduce((s, p) => s + p.stack, 0) + bf.g.pot;
check('大盲弃牌后筹码守恒（前注没蒸发也没退回）', totalChips === 3000,
  `合计 ${totalChips}，应为 3000`);
check('弃牌的大盲没拿回前注', bf.g.players[bf.g.bbIndex].stack < 1000,
  `大盲剩 ${bf.g.players[bf.g.bbIndex].stack}`);

console.log('\n=== 筹码不足时前注被削减，不卡死 ===');
const gShort = new Game({
  players: [{ name: '我' }, { name: 'A' }],
  smallBlind: 10, bigBlind: 20, startStack: 30,
  blindInterval: 0, anteMultiple: 1, onEvent: () => {}
});
gShort.startHand();
drain();
const shortBB = gShort.players[gShort.bbIndex];
check('大盲付完盲注只剩 10，前注削到 10', gShort.deadAnte === 10, `实际 ${gShort.deadAnte}`);
check('大盲因前注全下', shortBB.allIn === true, `allIn=${shortBB.allIn}`);
check('大盲筹码不为负', shortBB.stack === 0, `实际 ${shortBB.stack}`);

console.log('\n=== 长局：带前注跑完整对局 ===');
function longRun() {
  const g = new Game({
    players: [{ name: '我' }, { name: 'A' }, { name: 'B' }, { name: 'C' }],
    smallBlind: 10, bigBlind: 20, startStack: 1000,
    blindInterval: 8, anteMultiple: 1, onEvent: () => {}
  });
  let hands = 0, broke = null;
  try {
    while (hands < 300) {
      if (!g.startHand()) break;
      hands++;
      let guard = 0;
      while (!g.handOver && guard++ < 400) {
        const idx = g.actingIndex;
        if (idx < 0) break;
        const p = g.players[idx];
        const mv = decideAction(g, p);
        g.applyAction(idx, mv.type, mv.target);
        drain();
      }
      drain();
      if (!g.handOver) { broke = `第 ${hands} 手未结束`; break; }
    }
  } catch (e) { broke = e.message; }
  const total = g.players.reduce((s, p) => s + p.stack, 0) + g.pot;
  return { hands, broke, total, g };
}
const lr = longRun();
check('带前注的对局无异常', !lr.broke, lr.broke || '');
check('带前注筹码守恒', lr.total === 4000, `合计 ${lr.total}，应为 4000`);
check('前注确实跟着涨盲涨过', lr.g.ante === lr.g.bigBlind,
  `ante=${lr.g.ante}, bb=${lr.g.bigBlind}`);
console.log(`  （跑了 ${lr.hands} 手，最终盲注 ${lr.g.smallBlind}/${lr.g.bigBlind}，前注 ${lr.g.ante}）`);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
