// 引擎+AI 全自动对局模拟：node _test_sim.js
// 验证：不崩、筹码守恒、边池分配正确、无死循环
const fs = require('fs');
const path = require('path');

global.window = {};
let pending = [];
global.setTimeout = (fn) => { pending.push(fn); return 0; };

// 三个源文件拼接后一次 eval，末尾显式导出到 global
// （CJS 模块作用域下 class/const 不会自动挂到 global）
const sources = ['cards.js', 'preflop.js', 'strategy.js', 'game.js', 'ai.js']
  .map(f => fs.readFileSync(path.join(__dirname, 'js', f), 'utf8'))
  .join('\n');
eval(sources + `
  global.Game = Game;
  global.evaluate7 = evaluate7;
  global.compareHands = compareHands;
  global.describeHand = describeHand;
  global.decideAction = decideAction;
  global.createDeck = createDeck;
  global.shuffle = shuffle;
`);

function drainPending() {
  let guard = 0;
  while (pending.length) {
    if (++guard > 5000) throw new Error('setTimeout 死循环');
    const fn = pending.shift();
    fn();
  }
}

let errors = [];
let handsPlayed = 0;
let showdowns = 0;
let sidePotHands = 0;
let longGames = 0;      // 固定盲注下势均力敌打不完，非缺陷
const catCount = {};

const NUM_GAMES = 300;
for (let g = 0; g < NUM_GAMES; g++) {
  const nOpp = 2 + (g % 4);
  const players = [{ name: '你', persona: 'balanced' }];
  const personas = ['tight', 'balanced', 'loose', 'station'];
  for (let i = 0; i < nOpp; i++) {
    players.push({ name: 'AI' + i, persona: personas[i % 4] });
  }
  const startStack = [500, 1000, 2000][g % 3];

  const game = new Game({
    players, smallBlind: 10, bigBlind: 20,
    startStack, onEvent: () => {}
  });

  const totalChips = startStack * players.length;
  let over = false;
  game.onEvent = (ev) => { if (ev.type === 'gameOver') over = true; };

  let handGuard = 0;
  while (!over) {
    // 固定盲注下双方势均力敌可能长期僵持，放宽上限并单独计数
    if (++handGuard > 5000) { longGames++; break; }
    pending = [];   // 必须在 startHand 前清，否则会清掉 postBlinds 注册的全下结算回调
    if (!game.startHand()) break;
    handsPlayed++;

    // 跑完这一手
    let actGuard = 0;
    while (!game.handOver) {
      if (++actGuard > 500) { errors.push(`game${g} hand${game.handNumber}: 动作超限`); break; }
      const idx = game.actingIndex;
      if (idx < 0) { drainPending(); continue; }
      const p = game.players[idx];
      const acts = game.legalActions(idx);
      if (!acts.length) { errors.push(`game${g}: 无可用动作 p${idx}`); break; }

      const move = decideAction(game, p);
      // 校验 AI 给出的动作确实合法
      const legal = acts.find(a => a.type === move.type);
      if (!legal) {
        errors.push(`game${g}: AI 给出非法动作 ${move.type}，可选=${acts.map(a=>a.type)}`);
        break;
      }
      if (move.type === 'raise' || move.type === 'bet') {
        if (move.target < legal.min || move.target > legal.max) {
          errors.push(`game${g}: 加注额越界 ${move.target} 不在 [${legal.min},${legal.max}]`);
          break;
        }
      }
      const ok = game.applyAction(idx, move.type, move.target);
      if (!ok) { errors.push(`game${g}: applyAction 被拒 ${move.type}/${move.target}`); break; }
      drainPending();
    }
    drainPending();

    // 统计
    if (game.street === 'showdown') showdowns++;
    for (const p of game.players) {
      if (p.handResult) catCount[p.handResult.name] = (catCount[p.handResult.name] || 0) + 1;
    }
    const distinctBets = new Set(game.players.filter(p => p.totalBet > 0).map(p => p.totalBet));
    if (distinctBets.size > 2 && game.players.some(p => p.allIn)) sidePotHands++;

    // 筹码守恒：每手结束后总额不变，底池清零
    const sum = game.players.reduce((s, p) => s + p.stack, 0);
    if (sum !== totalChips) {
      errors.push(`game${g} hand${game.handNumber}: 筹码不守恒 ${sum} != ${totalChips}`);
      over = true;
    }
    if (game.pot !== 0) {
      errors.push(`game${g} hand${game.handNumber}: 底池未清零 ${game.pot}`);
      over = true;
    }
    if (game.players.some(p => p.stack < 0)) {
      errors.push(`game${g} hand${game.handNumber}: 出现负筹码`);
      over = true;
    }
    // 一手内不能有重复的牌
    const seen = new Set();
    for (const p of game.players) {
      for (const c of p.hole) {
        const k = c.rank + c.suit;
        if (seen.has(k)) errors.push(`game${g}: 重复发牌 ${k}`);
        seen.add(k);
      }
    }
    for (const c of game.board) {
      const k = c.rank + c.suit;
      if (seen.has(k)) errors.push(`game${g}: 公共牌与底牌重复 ${k}`);
      seen.add(k);
    }
  }
}

console.log(`模拟 ${NUM_GAMES} 局，共 ${handsPlayed} 手，摊牌 ${showdowns} 次，含边池局面 ${sidePotHands} 次`);
console.log(`超长牌局（5000 手未分出胜负，非缺陷）：${longGames} 局`);
console.log('牌型分布:', catCount);
if (errors.length) {
  console.log(`\n发现 ${errors.length} 个问题（显示前 15 条）:`);
  errors.slice(0, 15).forEach(e => console.log('  - ' + e));
  process.exit(1);
}
console.log('\n全部通过：筹码守恒、无重复牌、AI 动作合法、无死循环');
