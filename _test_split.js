// 平分底池专项测试：验证份额金额与日志一致、筹码守恒
const fs = require('fs');
const path = require('path');

global.window = {};
let pending = [];
global.setTimeout = (fn) => { pending.push(fn); return 0; };

const src = ['cards.js', 'preflop.js', 'strategy.js', 'game.js', 'ai.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8')).join('\n');
eval(src + `
  globalThis.Game = Game;
  globalThis.decideAction = decideAction;
  globalThis.makeCard = makeCard;
`);

const drain = () => { let g = 0; while (pending.length) { if (++g > 5000) throw new Error('loop'); pending.shift()(); } };

let fail = 0, pass = 0;
const check = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.log(`FAIL ${name}` + (extra ? `\n  ${extra}` : '')); }
};

// ---- 构造一个必然平分的局面：两人公共牌成顺，底牌不参与 ----
function forcedSplit() {
  const players = [{ name: 'A' }, { name: 'B' }];
  const g = new Game({ players, smallBlind: 10, bigBlind: 20, startStack: 1000, onEvent: () => {} });
  g.startHand();

  // 强制双方底牌点数镜像（花色不同但牌力完全相同）
  g.players[0].hole = [makeCard(2, 's'), makeCard(3, 'h')];
  g.players[1].hole = [makeCard(2, 'd'), makeCard(3, 'c')];
  // 公共牌给出一条不含底牌的顺子，双方最佳牌型完全一致
  g.board = [makeCard(9, 's'), makeCard(10, 'h'), makeCard(11, 'd'), makeCard(12, 'c'), makeCard(13, 's')];
  g.street = 'river';

  // 盲注让两人投入不等（10 / 20），会被正确切成边池而无法平分。
  // 平分底池的前提是投入相同，这里补平到各 20。
  g.players.forEach(p => {
    const need = 20 - p.totalBet;
    if (need > 0) { p.stack -= need; p.totalBet += need; g.pot += need; }
    p.bet = 0;
  });

  const logs = [];
  g.onEvent = ev => { if (ev.type === 'log' && ev.kind === 'win') logs.push(ev.text); };

  const potBefore = g.pot;
  const stacksBefore = g.players.map(p => p.stack);
  g.finishHand();

  return { g, logs, potBefore, stacksBefore };
}

const r = forcedSplit();
const gained = r.g.players.map((p, i) => p.stack - r.stacksBefore[i]);

console.log(`底池 ${r.potBefore}，两人平分`);
console.log('实际入账:', gained);
console.log('日志:', r.logs);

check('两人各得一半', gained[0] === r.potBefore / 2 && gained[1] === r.potBefore / 2,
  `期望各 ${r.potBefore / 2}，实际 ${gained}`);
check('入账总和等于底池', gained[0] + gained[1] === r.potBefore,
  `${gained[0]}+${gained[1]} != ${r.potBefore}`);
check('底池已清零', r.g.pot === 0, `pot=${r.g.pot}`);

// 日志里的金额必须等于该玩家实际入账，而不是整池
for (let i = 0; i < r.logs.length; i++) {
  const m = r.logs[i].match(/(\d+)\s*$/);
  const amt = m ? Number(m[1]) : -1;
  check(`日志${i + 1}金额=份额而非整池`, amt === r.potBefore / 2,
    `日志写 ${amt}，份额应为 ${r.potBefore / 2}（整池 ${r.potBefore}）: "${r.logs[i]}"`);
}

// ---- 奇数底池：余数必须分掉，不能蒸发 ----
function oddPot() {
  const players = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
  const g = new Game({ players, smallBlind: 10, bigBlind: 20, startStack: 1000, onEvent: () => {} });
  g.startHand();
  for (const p of g.players) { p.folded = false; p.allIn = false; }
  // 三人牌力完全相同，底池 100 无法整除
  g.players.forEach((p, i) => { p.hole = [makeCard(2, ['s','d','c'][i]), makeCard(3, ['h','s','d'][i])]; });
  g.board = [makeCard(9, 's'), makeCard(10, 'h'), makeCard(11, 'd'), makeCard(12, 'c'), makeCard(13, 's')];
  g.street = 'river';
  // buildSidePots 只按各玩家 totalBet 算金额，不读 this.pot——所以只设 totalBet 即可
  // 三人各投 101/3，底池 101 无法被 3 整除，用来验证余数不会蒸发
  g.players.forEach(p => { p.bet = 0; p.totalBet = 101 / 3; });

  const before = g.players.map(p => p.stack);
  g.finishHand();
  const got = g.players.map((p, i) => p.stack - before[i]);
  return { got, sum: got.reduce((a, b) => a + b, 0) };
}

const odd = oddPot();
console.log('\n底池 101 三人平分（无法整除）:', odd.got, '合计', odd.sum);
check('奇数底池余数不蒸发', odd.sum === 101, `合计 ${odd.sum} != 101`);
check('每人至少拿到 floor(101/3)=33', odd.got.every(v => v >= 33), `实际 ${odd.got}`);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
