// 涨盲测试：验证翻倍时机、金额、以及盲注投入随等级变化
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
`);

const drain = () => { let g = 0; while (pending.length) { if (++g > 5000) break; pending.shift()(); } };

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`); }
};

// 本文件只验证涨盲，关掉前注免得底池金额里混进第三个变量（前注另有专项测试）
function mkGame(interval, anteMultiple = 0) {
  return new Game({
    players: [{ name: '我' }, { name: 'A' }, { name: 'B' }],
    smallBlind: 10, bigBlind: 20, startStack: 1000000,
    blindInterval: interval, anteMultiple, onEvent: () => {}
  });
}

console.log('\n=== 每 10 手翻倍的时间点 ===');
const g = mkGame(10);
const levels = [];
for (let h = 1; h <= 31; h++) {
  g.startHand();
  levels.push({ hand: g.handNumber, sb: g.smallBlind, bb: g.bigBlind, lv: g.blindLevel });
  // 直接结束本手，只关心盲注变化
  g.handOver = true;
}
const at = n => levels.find(l => l.hand === n);
check('第 1 手为 10/20', at(1).sb === 10 && at(1).bb === 20, JSON.stringify(at(1)));
check('第 10 手仍为 10/20', at(10).sb === 10 && at(10).bb === 20, JSON.stringify(at(10)));
check('第 11 手升到 20/40', at(11).sb === 20 && at(11).bb === 40, JSON.stringify(at(11)));
check('第 21 手升到 40/80', at(21).sb === 40 && at(21).bb === 80, JSON.stringify(at(21)));
check('第 31 手升到 80/160', at(31).sb === 80 && at(31).bb === 160, JSON.stringify(at(31)));
check('等级随手数递增', at(1).lv === 1 && at(11).lv === 2 && at(21).lv === 3 && at(31).lv === 4);

console.log('\n=== 不涨盲模式 ===');
const g0 = mkGame(0);
for (let h = 1; h <= 40; h++) { g0.startHand(); g0.handOver = true; }
check('interval=0 时盲注不变', g0.smallBlind === 10 && g0.bigBlind === 20,
  `实际 ${g0.smallBlind}/${g0.bigBlind}`);
check('interval=0 时等级恒为 1', g0.blindLevel === 1, `实际 ${g0.blindLevel}`);

console.log('\n=== 每 5 手翻倍 ===');
const g5 = mkGame(5);
const l5 = [];
for (let h = 1; h <= 16; h++) { g5.startHand(); l5.push(`${g5.handNumber}:${g5.bigBlind}`); g5.handOver = true; }
check('第 6 手升到 40', l5[5] === '6:40', `实际 ${l5[5]}`);
check('第 11 手升到 80', l5[10] === '11:80', `实际 ${l5[10]}`);
check('第 16 手升到 160', l5[15] === '16:160', `实际 ${l5[15]}`);

console.log('\n=== 盲注实际投入随等级变化 ===');
const g2 = mkGame(2);
// 第 1 手：10/20
g2.startHand();
const potHand1 = g2.pot;
g2.handOver = true;
// 第 2 手仍 10/20，第 3 手翻倍
g2.startHand(); g2.handOver = true;
g2.startHand();
const potHand3 = g2.pot;
check('第 1 手底池为 30（10+20）', potHand1 === 30, `实际 ${potHand1}`);
check('第 3 手底池为 60（20+40）', potHand3 === 60, `实际 ${potHand3}`);

console.log('\n=== minRaise 跟随涨盲 ===');
const g3 = mkGame(1);   // 每手都涨
g3.startHand();
const mr1 = g3.minRaise, bb1 = g3.bigBlind;
g3.handOver = true;
g3.startHand();
const mr2 = g3.minRaise, bb2 = g3.bigBlind;
check('minRaise 等于当前大盲', mr1 === bb1 && mr2 === bb2,
  `手1 minRaise=${mr1} bb=${bb1}；手2 minRaise=${mr2} bb=${bb2}`);
check('第 2 手大盲已翻倍', bb2 === bb1 * 2, `${bb1} -> ${bb2}`);

console.log('\n=== 涨盲事件与日志 ===');
const events = [];
const logs = [];
// 必须 3 人：2 人就是单挑，会走每手翻倍的加速规则，测不到常规节奏
const gE = new Game({
  players: [{ name: '我' }, { name: 'A' }, { name: 'B' }],
  smallBlind: 10, bigBlind: 20, startStack: 100000, blindInterval: 3,
  onEvent: ev => {
    if (ev.type === 'blindUp') events.push(ev);
    if (ev.type === 'log' && ev.kind === 'blind') logs.push(ev.text);
  }
});
for (let h = 1; h <= 7; h++) { gE.startHand(); gE.handOver = true; }
check('触发 2 次涨盲事件（第4、7手）', events.length === 2,
  `实际 ${events.length}: ${events.map(e => 'L' + e.level).join(',')}`);
check('事件带正确金额', events[0] && events[0].smallBlind === 20 && events[0].bigBlind === 40,
  events[0] ? `${events[0].smallBlind}/${events[0].bigBlind}` : 'none');
check('写入盲注日志', logs.length === 2 && /盲注升至/.test(logs[0]),
  `实际 ${logs.length} 条: ${logs[0] || 'none'}`);

console.log('\n=== 单挑加速：只剩两家时每手翻倍 ===');
function mkHU(interval) {
  return new Game({
    players: [{ name: '我' }, { name: 'A' }],
    smallBlind: 10, bigBlind: 20, startStack: 10000000,
    blindInterval: interval, anteMultiple: 0, onEvent: () => {}
  });
}
const hu = mkHU(10);           // interval 很长，涨的只可能来自单挑规则
const huLv = [];
for (let h = 1; h <= 5; h++) {
  hu.startHand();
  huLv.push({ hand: hu.handNumber, sb: hu.smallBlind, bb: hu.bigBlind, lv: hu.blindLevel });
  hu.handOver = true;
}
check('单挑第 1 手不涨，仍是基础盲注 10/20',
  huLv[0].sb === 10 && huLv[0].bb === 20, JSON.stringify(huLv[0]));
check('单挑第 2 手翻倍到 20/40',
  huLv[1].sb === 20 && huLv[1].bb === 40, JSON.stringify(huLv[1]));
check('单挑第 3 手翻倍到 40/80',
  huLv[2].sb === 40 && huLv[2].bb === 80, JSON.stringify(huLv[2]));
check('单挑第 5 手已到 160/320',
  huLv[4].sb === 160 && huLv[4].bb === 320, JSON.stringify(huLv[4]));
check('单挑每手升一级', huLv.map(l => l.lv).join(',') === '1,2,3,4,5',
  huLv.map(l => l.lv).join(','));

// 关掉涨盲就不该因为单挑而擅自翻倍——尊重用户的「不涨盲」选择
const huOff = mkHU(0);
for (let h = 1; h <= 6; h++) { huOff.startHand(); huOff.handOver = true; }
check('关闭涨盲时单挑也不翻倍',
  huOff.smallBlind === 10 && huOff.bigBlind === 20 && huOff.blindLevel === 1,
  `实际 ${huOff.smallBlind}/${huOff.bigBlind} L${huOff.blindLevel}`);

// 多人局淘汰到只剩两家后，应当从当前级别继续往上，绝不能被手数公式拉回去
const shrink = new Game({
  players: [{ name: '我' }, { name: 'A' }, { name: 'B' }],
  smallBlind: 10, bigBlind: 20, startStack: 10000000,
  blindInterval: 10, anteMultiple: 0, onEvent: () => {}
});
for (let h = 1; h <= 12; h++) { shrink.startHand(); shrink.handOver = true; }
const lvBefore = shrink.blindLevel, bbBefore = shrink.bigBlind;
shrink.players[2].sittingOut = true;        // B 出局，进入单挑
shrink.startHand();
const lvAfter = shrink.blindLevel, bbAfter = shrink.bigBlind;
check('多人阶段按手数涨到 L2', lvBefore === 2 && bbBefore === 40,
  `L${lvBefore} bb=${bbBefore}`);
check('转入单挑后在原级别上继续翻倍，不回退',
  lvAfter === lvBefore + 1 && bbAfter === bbBefore * 2,
  `L${lvBefore}(${bbBefore}) -> L${lvAfter}(${bbAfter})`);

console.log('\n=== 涨盲后完整对局仍能跑通 ===');
const gFull = new Game({
  players: [{ name: '我', persona: 'balanced' }, { name: 'A', persona: 'tight' },
            { name: 'B', persona: 'loose' }],
  smallBlind: 10, bigBlind: 20, startStack: 2000, blindInterval: 3,
  onEvent: () => {}
});
let over = false;
gFull.onEvent = ev => { if (ev.type === 'gameOver') over = true; };
const total = 2000 * 3;
let hands = 0, broke = false;
while (!over && hands < 60) {
  if (!gFull.startHand()) break;
  hands++;
  pending = [];
  let guard = 0;
  while (!gFull.handOver) {
    if (++guard > 400) { broke = true; break; }
    const idx = gFull.actingIndex;
    if (idx < 0) { drain(); continue; }
    const move = decideAction(gFull, gFull.players[idx]);
    if (!gFull.applyAction(idx, move.type, move.target)) { broke = true; break; }
    drain();
  }
  drain();
  const sum = gFull.players.reduce((s, p) => s + p.stack, 0);
  if (sum !== total) { broke = true; break; }
}
check('涨盲下对局无异常', !broke, `hands=${hands}`);
check('涨盲下筹码守恒',
  gFull.players.reduce((s, p) => s + p.stack, 0) === total,
  `${gFull.players.reduce((s, p) => s + p.stack, 0)} != ${total}`);
check('盲注确实涨过', gFull.bigBlind > 20, `最终大盲 ${gFull.bigBlind}`);
console.log(`  （跑了 ${hands} 手，最终盲注 ${gFull.smallBlind}/${gFull.bigBlind}，L${gFull.blindLevel}）`);

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
