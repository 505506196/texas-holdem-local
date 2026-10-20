// UI 层：渲染牌桌、接收玩家输入、驱动 AI 行动

// 至少要够 7 个对手，否则 8 人局会取到 undefined
const AI_NAMES = ['老陈', '阿杰', '大刘', '小林', '阿May', '老K', '阿泰', '小美', '老周'];
const AI_DELAY = 750;          // AI 思考延时，让节奏可读

let game = null;
let config = { opponents: 3, stack: 1000, sb: 10, bb: 20, style: 'random', blindUp: 10, ante: 1 };
let revealAll = false;         // 摊牌时是否公开所有手牌
let winnerIds = [];
let aiTimer = null;
let resultTimer = null;        // handEnd 后延迟展示结果的句柄，换手时必须清掉
// 每开新一手 +1。所有延迟回调都捕获发起时的世代号，执行时比对，
// 不一致说明牌局已经翻篇——回调必须自行作废，否则会作用到新牌局上。
let handGen = 0;
let stackAtHandStart = 0;      // 本手开局时我的筹码，用于算本手盈亏
let fastForward = false;       // 我弃牌后快进本手，跳过 AI 思考延时
let seatEls = [];              // 座位 DOM 缓存，索引对齐 game.players
let seatLayoutKey = '';        // 人数变了才重排座位

const $ = id => document.getElementById(id);

// ---------------- 设置界面 ----------------
function initSetup() {
  bindSeg('optOpponents', v => config.opponents = Number(v));
  bindSeg('optStack', v => config.stack = Number(v));
  bindSeg('optBlinds', v => {
    const [sb, bb] = v.split(',').map(Number);
    config.sb = sb; config.bb = bb;
  });
  bindSeg('optStyle', v => config.style = v);
  bindSeg('optBlindUp', v => config.blindUp = Number(v));
  bindSeg('optAnte', v => config.ante = Number(v));

  $('btnStart').onclick = startGame;
  $('btnMenu').onclick = () => {
    if (aiTimer) clearTimeout(aiTimer);
    clearHeCountdown();
    $('game-screen').classList.add('hidden');
    $('setup-screen').classList.remove('hidden');
    closePanels();
    $('gameover-overlay').classList.add('hidden');
  };

  const goNext = () => {
    clearHeCountdown();
    closePanels();
    $('handEndBar').classList.add('hidden');
    $('skipBar').classList.add('hidden');
    nextHand();
  };
  $('btnNextHand').onclick = goNext;
  $('btnReviewNext').onclick = goNext;
  $('btnHeNext').onclick = goNext;

  $('btnReview').onclick = showReview;
  $('btnHeReview').onclick = showReview;
  $('btnSkip').onclick = skipToEnd;
  $('btnCloseResult').onclick = () => {
    $('result-panel').classList.add('hidden');
    syncPanelOpen();
  };
  $('btnCloseReview').onclick = () => {
    $('review-panel').classList.add('hidden');
    syncPanelOpen();
  };

  $('btnRestart').onclick = () => {
    $('gameover-overlay').classList.add('hidden');
    startGame();
  };
}

function closePanels() {
  $('result-panel').classList.add('hidden');
  $('review-panel').classList.add('hidden');
  syncPanelOpen();
}

// 侧栏是 fixed 定位，牌桌感知不到它；打开时给主区域加右内边距避让
function syncPanelOpen() {
  const open = !$('result-panel').classList.contains('hidden')
    || !$('review-panel').classList.contains('hidden');
  $('game-screen').classList.toggle('panel-open', open);
}

function bindSeg(id, onPick) {
  const box = $(id);
  box.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      box.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      onPick(b.dataset.v);
    };
  });
}

// ---------------- 建局 ----------------
function startGame() {
  const personaPool = config.style === 'random'
    ? ['tight', 'balanced', 'loose', 'station']
    : [config.style];

  const names = AI_NAMES.slice().sort(() => Math.random() - 0.5);
  const players = [{ name: '你', isHuman: true }];
  for (let i = 0; i < config.opponents; i++) {
    players.push({
      name: names[i],
      persona: personaPool[i % personaPool.length]
    });
  }

  game = new Game({
    players,
    smallBlind: config.sb,
    blindInterval: config.blindUp,
    anteMultiple: config.ante,
    bigBlind: config.bb,
    startStack: config.stack,
    onEvent: handleEvent
  });

  // 新开一局必须重建座位：人数可能没变，但座位绑的是上一局的玩家状态
  seatLayoutKey = '';
  $('setup-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  $('logCurrent').innerHTML = '';
  $('logHistory').innerHTML = '';
  $('logHistWrap').classList.add('hidden');
  nextHand();
}

// 本手结束后「下一手」的自动倒计时：不看复盘就 10 秒后自动进入下一手
let heTimer = null;
function clearHeCountdown() {
  if (heTimer) { clearInterval(heTimer); heTimer = null; }
  $('btnHeNext').textContent = '下一手';
}
function startHeCountdown(sec, onDone) {
  clearHeCountdown();
  let left = sec;
  const btn = $('btnHeNext');
  btn.textContent = `下一手 (${left})`;
  heTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearHeCountdown(); onDone(); }
    else btn.textContent = `下一手 (${left})`;
  }, 1000);
}

function nextHand() {
  // 重入保护：当前手还没结束就被调到，说明是野定时器或连点造成的重复调用。
  // game.startHand() 不检查 handOver，放任进去会直接重新发牌——手牌号跳跃、
  // rollLogToHistory 把进行中的日志归档冲走，表现就是「突然跳手 + 记录缺失」。
  if (game && !game.handOver) {
    clearHeCountdown();
    return;
  }
  clearHeCountdown();
  if (resultTimer) { clearTimeout(resultTimer); resultTimer = null; }
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  revealAll = false;
  winnerIds = [];
  fastForward = false;
  $('handEndBar').classList.add('hidden');
  $('skipBar').classList.add('hidden');
  // 必须先归档（要用旧的 stackAtHandStart 算上一手盈亏），再更新为本手起点
  // 我输光了就不该再开新一手——否则只能干看着 AI 继续打
  if (game.players[0].stack <= 0) {
    handGen++;
    showGameOver({ winner: null, humanBroke: true });
    return;
  }

  rollLogToHistory();
  stackAtHandStart = game.players[0].stack;
  handGen++;                      // 先递增，让所有旧回调立刻失效
  const ok = game.startHand();
  if (ok) {
    render();
    scheduleTurn();
  }
}

// ---------------- 事件处理 ----------------
function handleEvent(ev) {
  switch (ev.type) {
    case 'log':
      appendLog(ev);
      break;
    case 'street':
    case 'action':
    case 'handStart':
      render();
      syncSkipBar();
      break;
    case 'turn':
      render();
      scheduleTurn();
      break;
    case 'handEnd':
      revealAll = ev.showCards;
      winnerIds = ev.winners.map(w => w.player.id);
      hideActions();          // 本手已结束，动作条一律收起，不依赖按钮自己清
      render();
      // 句柄要留着：这个延迟回调会调 nextHand，若跨手存活会把进行中的牌局作废
      if (resultTimer) clearTimeout(resultTimer);
      {
        const gen = handGen;
        resultTimer = setTimeout(() => {
          if (gen !== handGen) return;          // 牌局已翻篇，这次结果作废
          showResult(ev.winners, ev.showCards);
        }, fastForward ? 120 : 600);
      }
      break;
    case 'blindUp': {
      // 闪一下标签，避免涨盲被忽略
      const bl = $('blindLabel');
      bl.classList.remove('bumped');
      void bl.offsetWidth;          // 强制重排，让动画可重复触发
      bl.classList.add('bumped');
      break;
    }
    case 'gameOver': {
      const gen = handGen;
      setTimeout(() => { if (gen === handGen) showGameOver(ev); }, 500);
      break;
    }
  }
}

// 轮到谁行动：人类显示按钮，AI 延时自动决策
function scheduleTurn() {
  if (aiTimer) clearTimeout(aiTimer);
  if (!game || game.handOver) {
    hideActions();
    return;
  }
  const idx = game.actingIndex;
  if (idx < 0) { hideActions(); return; }

  const p = game.players[idx];
  if (p.isHuman) {
    showActions(p);
    $('skipBar').classList.add('hidden');
  } else {
    hideActions();
    syncSkipBar();

    const delay = fastForward ? 0 : AI_DELAY + Math.random() * 400;
    const gen = handGen;
    aiTimer = setTimeout(() => {
      // 跨手时 actingIndex 可能碰巧撞上旧的 idx，单靠它挡不住，要比世代号
      if (gen !== handGen) return;
      if (!game || game.handOver || game.actingIndex !== idx) return;
      const move = decideAction(game, p);
      game.applyAction(idx, move.type, move.target);
    }, delay);
  }
}

// 只在「我已弃牌 + 本手仍在进行 + 未快进」时显示跳过入口
function syncSkipBar() {
  if (!game) return;
  const show = game.players[0].folded
    && !game.players[0].sittingOut
    && !game.handOver
    && !fastForward;
  $('skipBar').classList.toggle('hidden', !show);
}

// 跳过本手：我已弃牌，剩下的对手行动无需等待动画节奏
function skipToEnd() {
  if (!game || game.handOver) return;
  fastForward = true;
  $('skipBar').classList.add('hidden');
  if (aiTimer) clearTimeout(aiTimer);
  scheduleTurn();
}

// ---------------- 渲染 ----------------
function render() {
  if (!game) return;
  $('handNumber').textContent = `第 ${game.handNumber} 手`;
  $('logHandNo').textContent = `第 ${game.handNumber} 手`;
  // 盲注等级：涨盲后要能一眼看到当前级别，以及距下次涨盲还有几手
  const bl = $('blindLabel');
  bl.textContent = `盲注 ${game.smallBlind}/${game.bigBlind}`
    + (game.ante > 0 ? `+${game.ante}` : '')
    + (game.blindLevel > 1 ? ` · L${game.blindLevel}` : '');
  const anteTip = game.ante > 0 ? `，大盲位另付前注 ${game.ante}` : '';
  if (game.blindInterval > 0) {
    const left = game.blindInterval - ((game.handNumber - 1) % game.blindInterval);
    bl.title = `第 ${game.blindLevel} 级，再 ${left} 手后翻倍${anteTip}`;
  } else {
    bl.title = `固定盲注${anteTip}`;
  }
  $('streetLabel').textContent = STREET_LABEL[game.street] || '';
  $('potDisplay').textContent = `底池 ${game.pot}`;
  renderBoard();
  renderSeats();
}

// 牌元素带入场动画，整块重建就会让全桌牌跟着行动切换一起重播——看起来就是一直在闪。
// 所以牌按「牌面身份」复用：位置上的牌没变就原地留着，只有真的换了牌才重建。
function cardKey(card, faceUp) {
  if (!card) return 'ph';
  return faceUp ? `${card.label}${card.suit}` : 'back';
}

function syncCards(box, specs) {
  for (let i = 0; i < specs.length; i++) {
    const cur = box.children[i];
    if (cur && cur.dataset.k === specs[i].k) continue;
    const el = specs[i].make();
    el.dataset.k = specs[i].k;
    if (cur) box.replaceChild(el, cur);
    else box.appendChild(el);
  }
  while (box.children.length > specs.length) box.removeChild(box.lastChild);
}

function placeholderEl() {
  const ph = document.createElement('div');
  ph.className = 'card back dim';
  return ph;
}

function renderBoard() {
  const specs = game.board.map(c => ({ k: cardKey(c, true), make: () => cardEl(c) }));
  // 未发出的公共牌用占位保持布局稳定
  for (let i = game.board.length; i < 5; i++) {
    specs.push({ k: 'ph', make: placeholderEl });
  }
  syncCards($('board'), specs);
}

function cardEl(card, small) {
  const el = document.createElement('div');
  el.className = 'card' + (small ? ' small' : '');
  if (card.suit === 'h' || card.suit === 'd') el.classList.add('red');
  // 左上角索引 + 中央大花色：余光扫到角标即可认牌
  el.innerHTML =
    `<div class="idx"><div class="r">${card.label}</div><div class="s">${card.symbol}</div></div>`
    + `<div class="pip">${card.symbol}</div>`;
  return el;
}

function backEl(small) {
  const el = document.createElement('div');
  el.className = 'card back' + (small ? ' small' : '');
  return el;
}

// 内容没变就不写回 DOM，省掉无谓的重排
function setText(el, txt) {
  if (el && el.textContent !== txt) el.textContent = txt;
}

// 用项目统一的 .hidden 控制显隐。不用 [hidden] 属性：这些元素自带 display 值，
// 会盖掉浏览器对 [hidden] 的默认样式
function setShown(el, shown) {
  if (el) el.classList.toggle('hidden', !shown);
}

// 座位沿椭圆分布，人类固定在正下方。
// 骨架只在人数变化时建一次，之后每次行动只改文本和 class，
// 轮转靠 .acting 高亮框平滑过渡，牌面一概不动。
function renderSeats() {
  const n = game.players.length;
  if (seatLayoutKey !== String(n)) buildSeats(n);
  game.players.forEach((p, i) => updateSeat(p, i, seatEls[i]));
}

function buildSeats(n) {
  const box = $('seats');
  seatLayoutKey = String(n);
  seatEls = [];
  box.innerHTML = '';
  // 人多时座位要缩小并外扩，否则会互相重叠
  box.className = 'seats seats-' + (n >= 7 ? 'lg' : n >= 5 ? 'md' : 'sm');
  const rx = n >= 7 ? 44 : n >= 5 ? 40 : 37;
  const ry = n >= 7 ? 45 : 41;

  game.players.forEach((p, i) => {
    // i=0 在底部（90°），其余顺时针铺开
    const angle = 90 + (360 / n) * i;
    const rad = angle * Math.PI / 180;
    const x = 50 + rx * Math.cos(rad);
    const y = 50 + ry * Math.sin(rad);

    const seat = document.createElement('div');
    seat.className = 'seat' + (y < 40 ? ' top' : '') + (p.isHuman ? ' me' : '');
    seat.style.left = x + '%';
    seat.style.top = y + '%';
    // 浮动元素（位置标记、ALL IN、下注筹码）常驻骨架，用 hidden 控制显隐，
    // 这样它们的出现不会连带把整个座位重建一遍
    seat.innerHTML = `
      <div class="pos-mark hidden"></div>
      <div class="allin-tag hidden">ALL IN</div>
      <div class="win-badge hidden">🏆 赢</div>
      <div class="nm"></div>
      <div class="st"></div>
      <div class="act"></div>
      <div class="hole"></div>
      <div class="made"></div>
      <div class="bet-chip hidden">
        <span class="chip-dot"></span><span class="chip-amt"></span><span class="chip-behind hidden"></span>
      </div>`;
    box.appendChild(seat);
    seatEls.push(seat);
  });
}

function updateSeat(p, i, seat) {
  if (!seat) return;

  const isWinner = winnerIds.includes(p.id);
  seat.classList.toggle('acting', i === game.actingIndex && !game.handOver);
  seat.classList.toggle('folded', p.folded || p.sittingOut);
  seat.classList.toggle('winner', isWinner);
  // 本街最后一个加注者＝当前主动方，面对他才要决定防守强度，单独标出来
  seat.classList.toggle('aggressor',
    game.lastAggressor === i && !p.folded && !p.sittingOut && !game.handOver);

  setText(seat.querySelector('.nm'), p.name);
  setText(seat.querySelector('.st'), p.sittingOut ? '已淘汰' : String(p.stack));
  setText(seat.querySelector('.act'), p.lastAction || '');

  // 摊牌时显示成手牌型；赢家金色、其余暗灰，一眼看出谁的牌大
  const madeEl = seat.querySelector('.made');
  const showMade = revealAll && p.handResult && !p.folded;
  setText(madeEl, showMade ? describeHand(p.handResult) : '');
  madeEl.classList.toggle('win', showMade && isWinner);
  madeEl.classList.toggle('lose', showMade && !isWinner);

  // 摊牌且有胜负（showCards）时，赢家座位挂「🏆 赢」角标
  setShown(seat.querySelector('.win-badge'), revealAll && isWinner);

  // 位置标记做成独立圆牌挂在座位角上，比挤在名字里更醒目
  const posMark = i === game.buttonIndex ? { cls: 'btn-d', txt: 'D' }
    : i === game.sbIndex ? { cls: 'sb', txt: 'SB' }
    : i === game.bbIndex ? { cls: 'bb', txt: 'BB' }
    : null;
  const mark = seat.querySelector('.pos-mark');
  const showMark = !!posMark && !p.sittingOut;
  if (showMark) {
    mark.className = 'pos-mark ' + posMark.cls;
    setText(mark, posMark.txt);
  }
  setShown(mark, showMark);

  setShown(seat.querySelector('.allin-tag'), p.allIn);

  // 手牌：自己始终可见，对手仅摊牌时可见
  const holeBox = seat.querySelector('.hole');
  if (p.hole.length && !p.sittingOut) {
    const visible = p.isHuman || (revealAll && !p.folded);
    syncCards(holeBox, p.hole.map(c => ({
      k: cardKey(c, visible),
      make: () => (visible ? cardEl(c, true) : backEl(true))
    })));
  } else {
    syncCards(holeBox, []);
  }

  // 本轮下注：带筹码图形，并标出相对当前最高注的状态
  const chip = seat.querySelector('.bet-chip');
  setShown(chip, p.bet > 0);
  if (p.bet > 0) {
    chip.classList.toggle('matched', p.bet >= game.currentBet && game.currentBet > 0);
    setText(chip.querySelector('.chip-amt'), String(p.bet));
    const behind = game.currentBet - p.bet;
    const bh = chip.querySelector('.chip-behind');
    const showBehind = behind > 0 && !p.folded && !p.allIn;
    if (showBehind) setText(bh, `差 ${behind}`);
    setShown(bh, showBehind);
  }
}

// 日志分两段：当前手全量展示在上，历史手折叠成灰色摘要在下
function appendLog(entry) {
  const cur = $('logCurrent');
  const line = document.createElement('div');
  line.className = entry.kind || 'info';
  line.textContent = entry.text;
  cur.appendChild(line);
  cur.scrollTop = cur.scrollHeight;
}

// 新一手开始时，把上一手的内容压进历史区
function rollLogToHistory() {
  const cur = $('logCurrent');
  const hist = $('logHistory');
  if (!cur.children.length) return;

  const lines = [...cur.children];
  // 只保留结果行作为摘要，过程行丢弃，避免历史区无限膨胀
  const resultLines = lines.filter(l => l.classList.contains('win'));

  const item = document.createElement('div');
  item.className = 'hist-item';
  // 本函数在 startHand() 之前调用，handNumber 仍指向刚结束那手
  const delta = game.players[0].stack - stackAtHandStart;
  const deltaText = delta === 0 ? '±0' : (delta > 0 ? `+${delta}` : `${delta}`);
  const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';
  item.innerHTML = `<div class="hist-hd">第 ${game.handNumber} 手`
    + `<span class="hist-delta ${cls}">${deltaText}</span></div>`;
  for (const r of resultLines) {
    const d = document.createElement('div');
    d.className = 'hist-win';
    d.textContent = r.textContent;
    item.appendChild(d);
  }
  // 最近的手放最上面
  hist.insertBefore(item, hist.firstChild);
  $('logHistWrap').classList.remove('hidden');
  cur.innerHTML = '';
}

// ---------------- 玩家动作栏 ----------------
function hideActions() {
  $('actionBar').classList.add('hidden');
  $('raisePanel').classList.add('hidden');
}

function showActions(p) {
  const bar = $('actionBar');
  const row = $('actionRow');
  bar.classList.remove('hidden');
  $('raisePanel').classList.add('hidden');
  row.innerHTML = '';

  const acts = game.legalActions(p.id);
  const raiseAct = acts.find(a => a.type === 'raise' || a.type === 'bet');

  for (const a of acts) {
    // 加注单独用滑杆面板，不放进普通按钮行
    if (a.type === 'raise' || a.type === 'bet') {
      const btn = mkBtn(a.label, 'act-raise');
      btn.onclick = () => openRaisePanel(p, a);
      row.appendChild(btn);
      continue;
    }
    const cls = {
      fold: 'act-fold', check: 'act-check', call: 'act-call', allin: 'act-allin'
    }[a.type] || 'act-check';
    const btn = mkBtn(a.label, cls);
    btn.onclick = () => {
      hideActions();
      game.applyAction(p.id, a.type, a.amount);
    };
    row.appendChild(btn);
  }

  // 键盘快捷键：F 弃牌 / C 过牌跟注 / R 加注
  document.onkeydown = e => {
    if (game.handOver || !game.players[game.actingIndex]?.isHuman) return;
    const k = e.key.toLowerCase();
    if (k === 'f') {
      const a = acts.find(x => x.type === 'fold');
      if (a) { hideActions(); game.applyAction(p.id, 'fold'); }
    } else if (k === 'c') {
      const a = acts.find(x => x.type === 'check' || x.type === 'call');
      if (a) { hideActions(); game.applyAction(p.id, a.type, a.amount); }
    } else if (k === 'r' && raiseAct) {
      openRaisePanel(p, raiseAct);
    }
  };
}

function mkBtn(label, cls) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  return b;
}

function openRaisePanel(p, act) {
  const panel = $('raisePanel');
  const slider = $('raiseSlider');
  const input = $('raiseInput');
  panel.classList.remove('hidden');

  slider.min = act.min;
  slider.max = act.max;
  slider.value = act.min;
  input.min = act.min;
  input.max = act.max;
  input.value = act.min;

  slider.oninput = () => input.value = slider.value;
  input.oninput = () => {
    let v = Number(input.value);
    if (v >= act.min && v <= act.max) slider.value = v;
  };

  // 池比例按钮：按「跟注后底池」计算目标额
  panel.querySelectorAll('.chip-btn').forEach(b => {
    b.onclick = () => {
      const ratio = Number(b.dataset.ratio);
      const toCall = game.currentBet - p.bet;
      let target = game.currentBet + Math.round((game.pot + toCall) * ratio);
      target = Math.max(act.min, Math.min(act.max, target));
      slider.value = target;
      input.value = target;
    };
  });

  $('btnConfirmRaise').onclick = () => {
    let target = Math.round(Number(input.value));
    target = Math.max(act.min, Math.min(act.max, target));
    hideActions();
    game.applyAction(p.id, act.type, target);
  };
}

// ---------------- 结果浮层 ----------------
function showResult(winners, showCards) {
  resultTimer = null;
  // 本函数是延迟回调：真执行时牌局可能已经进入下一手。
  // 此时既不能展示上一手的结果，更不能让它启动倒计时去作废进行中的牌局。
  if (!game || !game.handOver) return;

  const body = $('resultBody');
  body.innerHTML = '';

  // 同一玩家可能赢多个池，合并展示
  const merged = {};
  for (const w of winners) {
    const key = w.player.id;
    if (!merged[key]) merged[key] = { player: w.player, amount: 0, desc: w.desc };
    merged[key].amount += w.amount;
  }

  $('resultTitle').textContent = showCards ? '摊牌结果' : '本手结束';

  for (const k in merged) {
    const w = merged[k];
    const row = document.createElement('div');
    row.className = 'win-row';
    row.innerHTML = `
      <div>
        <div class="w-name">${w.player.name}</div>
        <div class="w-desc">${w.desc}</div>
      </div>
      <div class="w-amt">+${w.amount}</div>
    `;
    body.appendChild(row);
  }

  const me = game.players[0];
  const note = document.createElement('p');
  note.style.marginTop = '12px';
  const delta = me.stack - stackAtHandStart;
  const deltaText = delta === 0 ? '持平' : (delta > 0 ? `+${delta}` : `${delta}`);
  note.textContent = `你的筹码：${me.stack}（本手 ${deltaText}）`;
  body.appendChild(note);

  // 本手没有可复盘的决策点时禁用按钮，避免点开空面板
  const hasDecisions = (game.handHistory || []).some(h => h.playerId === 0 && h.action);
  for (const id of ['btnReview', 'btnHeReview']) {
    const b = $(id);
    b.disabled = !hasDecisions;
    b.classList.toggle('disabled', !hasDecisions);
  }

  // 我已输光：这局到此为止，不给「下一手」，直接收尾结算
  if (game.players[0].stack <= 0) {
    closePanels();
    $('handEndBar').classList.add('hidden');
    $('skipBar').classList.add('hidden');
    const gen = handGen;
    setTimeout(() => { if (gen === handGen) showGameOver({ humanBroke: true }); }, 900);
    return;
  }

  // 我弃牌并主动「跳过本手」，说明不关心这手——直接进下一手，不弹操作条
  if (fastForward) { closePanels(); nextHand(); return; }

  // 结果内容已备好，但不主动展开侧栏——先给底部轻量条，由用户决定看不看
  closePanels();
  showHandEndBar(merged, delta, deltaText, showCards);
}

// 本手结束的底部操作条：摘要 + 「查看复盘 / 下一手」
function showHandEndBar(merged, delta, deltaText, showCards) {
  $('skipBar').classList.add('hidden');

  const winnerNames = Object.values(merged).map(w => w.player.name);
  const iWon = winnerNames.includes('你');
  const who = winnerNames.join('、');
  const cls = delta > 0 ? 'up' : delta < 0 ? 'down' : '';

  $('heInfo').innerHTML =
    `<span class="he-who ${iWon ? 'win' : ''}">${who} 赢得本手</span>`
    + `<span class="he-delta ${cls}">${delta === 0 ? '±0' : deltaText}</span>`
    + (showCards ? '' : '<span class="he-tag">未摊牌</span>');

  $('handEndBar').classList.remove('hidden');

  // 默认 10 秒后自动进下一手；点「查看复盘」或「下一手」会取消
  const gen = handGen;
  startHeCountdown(10, () => {
    if (gen !== handGen) return;      // 期间已经换手，这个倒计时是上一手的遗物
    closePanels();
    $('handEndBar').classList.add('hidden');
    $('skipBar').classList.add('hidden');
    nextHand();
  });
}

// ---------------- 复盘面板 ----------------
function showReview() {
  clearHeCountdown();
  const body = $('reviewBody');
  body.innerHTML = '<p class="rv-empty">正在模拟计算各决策点胜率，请稍候…</p>';
  $('result-panel').classList.add('hidden');
  $('review-panel').classList.remove('hidden');
  syncPanelOpen();

  // 蒙特卡洛是同步计算，先让浏览器把「计算中」渲染出来再开跑。
  // 它会阻塞主线程上千毫秒，期间排队的点击在解冻后一次性涌出，
  // 所以回调里必须确认牌局没翻篇——换手后 handHistory 已被清空。
  const gen = handGen;
  setTimeout(() => {
    if (gen !== handGen) return;
    const rv = reviewHand(game);
    if (gen !== handGen) return;      // 计算期间换手了，结果作废
    body.innerHTML = '';

    const sum = document.createElement('div');
    sum.className = 'rv-summary';
    sum.textContent = rv.summary;
    body.appendChild(sum);

    for (const pt of rv.points) {
      body.appendChild(reviewPointEl(pt));
    }

    // 本手命中的战术原则汇总，便于形成记忆点
    if (rv.principles && rv.principles.length) {
      const pbox = document.createElement('div');
      pbox.className = 'rv-principles';
      pbox.innerHTML = '<div class="rv-ph">本手涉及的原则</div>'
        + rv.principles.map(p => `<div class="rv-pi">· ${p}</div>`).join('');
      body.appendChild(pbox);
    }

    if (rv.points.length) {
      const calc = document.createElement('div');
      calc.className = 'rv-calc';
      calc.textContent = `胜率由蒙特卡洛模拟 ${MC_ITERATIONS} 次得出。对手底牌不是随机发，`
        + '而是枚举全部候选组合后，按他每街的动作与下注尺度逐一加权：'
        + '下注/加注会抬高该牌面上强牌与强听牌的权重、压低中等牌，'
        + '过牌则相反；大注更极化，小注范围更宽。因此"对手这条线路代表的牌"'
        + '是按当时可见的牌面算出来的，而非套用起手牌分数。'
        + '赔率门槛 = 跟注额 ÷ 跟注后底池；跟注期望值 = 胜率 × 跟注后底池 − 跟注额；'
        + '下注期望值还计入了按对手范围估算的弃牌率。'
        + '注意：这是范围加权的剥削性分析，不是 GTO 均衡解；'
        + '抽样误差约 ±2%，小数位不必深究。';
      body.appendChild(calc);
    }
  }, 60);
}

function reviewPointEl(pt) {
  const box = document.createElement('div');
  box.className = 'rv-point ' + pt.grade;

  const tagText = { good: '合理', ok: '可优化', leak: '漏洞' }[pt.grade];

  box.innerHTML = `
    <div class="rv-top">
      <span class="rv-street">${pt.streetLabel}　${pt.position}　对手 ${pt.opponents} 家</span>
      <span class="rv-tag ${pt.grade}">${tagText}</span>
    </div>
    <div class="rv-cards"></div>
    <div class="rv-facts">
      <span class="rv-chip hand">${pt.handLabel}</span>
      ${pt.textureLabel ? `<span class="rv-chip">${pt.textureLabel}</span>` : ''}
      ${pt.drawLabel ? `<span class="rv-chip draw">${pt.drawLabel} · ${pt.outs} outs</span>` : ''}
      <span class="rv-chip ${pt.isPFA ? 'pfa' : ''}">${pt.isPFA ? '翻前主动方' : '翻前被动方'}</span>
    </div>
    <div class="rv-ctx">底池 ${pt.pot}${pt.toCall > 0 ? `　需跟 ${pt.toCall}` : '　无人下注'}</div>
    ${pt.rangeDesc ? `<div class="rv-range">
      <span class="rr-hd">对手这条线路代表的牌${pt.usedFallback ? '（估算）' : ''}</span>
      <span class="rr-body">${pt.rangeDesc}</span>
    </div>` : ''}
    <div class="rv-bars">
      <div class="rv-bar-row">
        <span class="lb">你的胜率</span>
        <span class="rv-track"><span class="rv-fill eq" style="width:${(pt.equity * 100).toFixed(1)}%"></span></span>
        <span class="vl">${(pt.equity * 100).toFixed(0)}%</span>
      </div>
      ${pt.impliedBonus > 0.005 ? `
      <div class="rv-bar-row">
        <span class="lb">含隐含赔率</span>
        <span class="rv-track"><span class="rv-fill imp" style="width:${(pt.effectiveEquity * 100).toFixed(1)}%"></span></span>
        <span class="vl">${(pt.effectiveEquity * 100).toFixed(0)}%</span>
      </div>` : ''}
      <div class="rv-bar-row">
        <span class="lb">赔率门槛</span>
        <span class="rv-track"><span class="rv-fill need" style="width:${(pt.needEquity * 100).toFixed(1)}%"></span></span>
        <span class="vl">${(pt.needEquity * 100).toFixed(0)}%</span>
      </div>
    </div>
    ${pt.evTable ? `<div class="rv-evtable">
      <div class="rv-evhd">各选项期望值（筹码）</div>
      ${pt.evTable.rows.map(r => `
        <div class="rv-evrow ${r.isBest ? 'best' : ''} ${r.action === pt.actual ? 'chosen' : ''}">
          <span class="ev-act">${r.label}${r.action === pt.actual ? ' ·你选的' : ''}</span>
          <span class="ev-num ${r.ev >= 0 ? 'pos' : 'neg'}">${r.ev >= 0 ? '+' : ''}${r.ev.toFixed(0)}</span>
          <span class="ev-note">${r.note}</span>
        </div>`).join('')}
    </div>` : ''}
    <div class="rv-line">你的选择：<b>${pt.actualLabel}</b>　建议：<b>${pt.adviceLabel}</b>${pt.adviceSize ? `（${pt.adviceSize}）` : ''}</div>
    <div class="rv-line advice">${pt.adviceReason}</div>
    <div class="rv-note">${pt.gradeNote}${pt.evLoss > 0 ? `（期望损失约 ${pt.evLoss} 筹码）` : ''}</div>
    ${pt.principle ? `<div class="rv-principle">原则：${pt.principle}</div>` : ''}
  `;

  // 手牌与当时的公共牌
  const cardBox = box.querySelector('.rv-cards');
  for (const c of pt.hole) cardBox.appendChild(cardEl(c, true));
  if (pt.board.length) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '｜';
    cardBox.appendChild(sep);
    for (const c of pt.board) cardBox.appendChild(cardEl(c, true));
  } else {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '（翻牌前，无公共牌）';
    cardBox.appendChild(sep);
  }

  return box;
}

function showGameOver(ev) {
  const me = game.players[0];
  const humanWon = !me.sittingOut && me.stack > 0;
  $('gameoverTitle').textContent = humanWon ? '你赢了整桌' : '你被淘汰了';
  $('gameoverBody').textContent = humanWon
    ? `打完 ${game.handNumber} 手，你收下全部筹码 ${me.stack}。`
    : `坚持了 ${game.handNumber} 手，筹码见底。`;
  $('gameover-overlay').classList.remove('hidden');
}

initSetup();
