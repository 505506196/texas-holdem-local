// 德州扑克游戏引擎：状态机 + 下注逻辑 + 边池结算
// 纯逻辑，不碰 DOM。通过 onEvent 回调把变化推给 UI。

const STREETS = ['preflop', 'flop', 'turn', 'river', 'showdown'];
const STREET_LABEL = {
  preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌'
};

class Game {
  constructor(config) {
    this.baseSmallBlind = config.smallBlind || 10;
    this.baseBigBlind = config.bigBlind || 20;
    this.smallBlind = this.baseSmallBlind;
    this.bigBlind = this.baseBigBlind;
    // 每隔多少手把盲注翻一倍；0 表示固定盲注不涨
    this.blindInterval = config.blindInterval != null ? config.blindInterval : 10;
    this.blindLevel = 1;
    this.startStack = config.startStack || 1000;
    this.onEvent = config.onEvent || (() => {});

    this.players = config.players.map((p, i) => ({
      id: i,
      name: p.name,
      isHuman: !!p.isHuman,
      persona: p.persona || 'balanced',
      stack: this.startStack,
      hole: [],
      bet: 0,          // 本轮已投入
      totalBet: 0,     // 本手总投入，用于边池
      folded: false,
      allIn: false,
      acted: false,    // 本轮是否已行动过
      sittingOut: false,
      lastAction: '',
      handResult: null
    }));

    this.buttonIndex = 0;
    this.handNumber = 0;
    this.street = 'preflop';
    this.board = [];
    this.deck = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.actingIndex = -1;
    this.lastAggressor = -1;
    this.handOver = true;
    this.log = [];
    this.pots = [];
    this.handHistory = [];   // 本手每个决策点的快照，供复盘使用
  }

  emit(type, payload) {
    this.onEvent({ type, ...payload });
  }

  addLog(text, kind = 'info') {
    const entry = { text, kind, hand: this.handNumber, street: this.street };
    this.log.push(entry);
    this.emit('log', entry);
  }

  activePlayers() {
    return this.players.filter(p => !p.folded && !p.sittingOut);
  }

  // 还能继续行动的玩家（未弃牌、未 all-in）
  playersToAct() {
    return this.players.filter(p => !p.folded && !p.allIn && !p.sittingOut);
  }

  // ---------------- 开始新一手 ----------------
  startHand() {
    // 淘汰没钱的玩家
    for (const p of this.players) {
      if (p.stack <= 0) p.sittingOut = true;
    }
    const alive = this.players.filter(p => !p.sittingOut);
    if (alive.length < 2) {
      this.emit('gameOver', {
        winner: alive[0] || null,
        humanBroke: !this.players[0] || this.players[0].sittingOut
      });
      return false;
    }

    this.handNumber++;
    // 涨盲：每 blindInterval 手翻一倍（10/20 → 20/40 → 40/80 …）
    // 必须在 postBlinds 之前生效，且要早于 minRaise 的初始化
    if (this.blindInterval > 0) {
      const level = Math.floor((this.handNumber - 1) / this.blindInterval) + 1;
      if (level !== this.blindLevel) {
        this.blindLevel = level;
        const mult = Math.pow(2, level - 1);
        this.smallBlind = this.baseSmallBlind * mult;
        this.bigBlind = this.baseBigBlind * mult;
        this.addLog(
          `▲ 盲注升至第 ${level} 级：${this.smallBlind} / ${this.bigBlind}`,
          'blind'
        );
        this.emit('blindUp', {
          level, smallBlind: this.smallBlind, bigBlind: this.bigBlind
        });
      }
    }

    this.street = 'preflop';
    this.board = [];
    this.pot = 0;
    this.pots = [];
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.handOver = false;
    this.lastAggressor = -1;
    this.handHistory = [];
    // 翻前最后一个加注者＝翻前主动方。复盘要靠它判断范围优势归谁、
    // 以及我是不是「翻前被动方」（被动方反主动下注 donk bet 通常是错的）
    this.preflopAggressor = -1;

    for (const p of this.players) {
      p.hole = [];
      p.bet = 0;
      p.totalBet = 0;
      p.folded = p.sittingOut;
      p.allIn = false;
      p.acted = false;
      p.lastAction = '';
      p.handResult = null;
    }

    // 按钮移到下一个有效玩家
    if (this.handNumber > 1) {
      this.buttonIndex = this.nextOccupied(this.buttonIndex);
    } else if (this.players[this.buttonIndex].sittingOut) {
      this.buttonIndex = this.nextOccupied(this.buttonIndex);
    }

    this.deck = shuffle(createDeck());
    this.addLog(`—— 第 ${this.handNumber} 手开始，按钮位：${this.players[this.buttonIndex].name} ——`, 'street');

    // 发两张底牌
    for (let round = 0; round < 2; round++) {
      let idx = this.nextOccupied(this.buttonIndex);
      for (let n = 0; n < alive.length; n++) {
        this.players[idx].hole.push(this.deck.pop());
        idx = this.nextOccupied(idx);
      }
    }

    this.postBlinds(alive.length);
    this.emit('handStart', {});
    return true;
  }

  nextOccupied(from) {
    let i = from;
    for (let n = 0; n < this.players.length; n++) {
      i = (i + 1) % this.players.length;
      if (!this.players[i].sittingOut) return i;
    }
    return from;
  }

  nextActive(from) {
    let i = from;
    for (let n = 0; n < this.players.length; n++) {
      i = (i + 1) % this.players.length;
      const p = this.players[i];
      if (!p.sittingOut && !p.folded && !p.allIn) return i;
    }
    return -1;
  }

  postBlinds(aliveCount) {
    // 单挑时按钮位下小盲；三人以上按钮左手位下小盲
    const sbIndex = aliveCount === 2 ? this.buttonIndex : this.nextOccupied(this.buttonIndex);
    const bbIndex = this.nextOccupied(sbIndex);
    this.sbIndex = sbIndex;
    this.bbIndex = bbIndex;

    this.forceBet(sbIndex, this.smallBlind, '小盲');
    this.forceBet(bbIndex, this.bigBlind, '大盲');

    this.currentBet = Math.max(...this.players.map(p => p.bet));
    this.minRaise = this.bigBlind;
    // 翻牌前从大盲左手位开始行动
    this.actingIndex = this.nextActive(bbIndex);
    // 盲注涨到吃掉所有人筹码时，全桌都会被迫 all-in，此时无人可行动。
    // 原来回退成 actingIndex = bbIndex，但大盲已 all-in、没有合法动作，
    // 状态机就此卡死、底池留在池里无人结算。改为直接发完公共牌进摊牌。
    if (this.actingIndex === -1) {
      // 盲注吃光所有筹码、全员被迫全下：同步跑完公共牌并结算。
      // 不用 setTimeout —— 异步回调可能被宿主环境清掉而导致死锁。
      this.emit('turn', { index: -1, player: null });
      this.runOutBoard();
    }
  }

  // 所有人都 all-in：把剩余公共牌一次发完，然后结算
  runOutBoard() {
    if (this.handOver) return;
    while (this.board.length < 5) {
      this.deck.pop();                       // 烧牌
      this.board.push(this.deck.pop());
    }
    this.street = 'river';
    this.addLog(`—— 全员全下，发完公共牌：${this.board.map(cardToString).join(' ')} ——`, 'street');
    this.emit('street', { street: 'river', board: this.board });
    this.finishHand();
  }

  forceBet(index, amount, label) {
    const p = this.players[index];
    const put = Math.min(amount, p.stack);
    p.stack -= put;
    p.bet += put;
    p.totalBet += put;
    this.pot += put;
    if (p.stack === 0) p.allIn = true;
    p.lastAction = `${label} ${put}`;
    this.addLog(`${p.name} 下${label} ${put}${p.allIn ? '（全下）' : ''}`);
  }

  // ---------------- 玩家可用动作 ----------------
  legalActions(index) {
    const p = this.players[index];
    if (!p || p.folded || p.allIn || p.sittingOut) return [];
    const toCall = this.currentBet - p.bet;
    const acts = [];

    if (toCall > 0) {
      acts.push({ type: 'fold', label: '弃牌' });
      const callAmt = Math.min(toCall, p.stack);
      acts.push({
        type: 'call',
        label: callAmt >= p.stack ? `全下跟注 ${callAmt}` : `跟注 ${callAmt}`,
        amount: callAmt
      });
    } else {
      acts.push({ type: 'check', label: '过牌' });
    }

    // 加注/下注：需要有足够筹码超过当前注额
    const minTarget = toCall > 0
      ? this.currentBet + this.minRaise
      : Math.max(this.bigBlind, this.minRaise);
    const maxTarget = p.bet + p.stack;
    if (maxTarget > this.currentBet) {
      acts.push({
        type: toCall > 0 ? 'raise' : 'bet',
        label: toCall > 0 ? '加注' : '下注',
        min: Math.min(minTarget, maxTarget),
        max: maxTarget
      });
      acts.push({ type: 'allin', label: `全下 ${p.stack}`, amount: maxTarget });
    }
    return acts;
  }

  // ---------------- 执行动作 ----------------
  // target 为「本轮累计投入目标额」，非增量
  applyAction(index, type, target) {
    const p = this.players[index];
    if (this.handOver || index !== this.actingIndex) return false;

    const toCall = this.currentBet - p.bet;
    // 决策前快照：复盘要用行动当时的信息，事后状态已被改写
    const snapshot = {
      playerId: index,
      playerName: p.name,
      isHuman: p.isHuman,
      street: this.street,
      potBefore: this.pot,
      toCall,
      currentBet: this.currentBet,
      stackBefore: p.stack,
      betBefore: p.bet,
      hole: p.hole.slice(),
      board: this.board.slice(),
      opponentsLive: this.activePlayers().length - 1,
      // 复盘要按每个对手各自的行动推断范围，所以记下具体是谁还在牌局里
      liveOpponentIds: this.activePlayers().filter(q => q.id !== index).map(q => q.id),
      // 线路信息：翻前主动方是谁、我是否主动方、本街此前是否有人下注
      preflopAggressor: this.preflopAggressor,
      isPreflopAggressor: this.preflopAggressor === index,
      facingBet: toCall > 0,
      // 有效筹码（以底池为单位）决定该慢打还是快打、能否套池
      effectiveStack: Math.min(
        p.stack,
        Math.max(...this.activePlayers().filter(q => q.id !== index).map(q => q.stack), 0)
      ),
      // 本街已发生的动作序列，用于识别「对手连续过牌」等线路特征
      streetLog: this.handHistory
        .filter(h => h.street === this.street)
        .map(h => ({ id: h.playerId, action: h.action })),
      position: this.positionLabel(index),
      // 标准位置代号（BTN/CO/MP/UTG/SB/BB）与「是否有位置」布尔值。
      // review.js 原先靠中文串匹配判断位置，很脆；这里由引擎直接给结论。
      seat: this.seatCode(index),
      isInPosition: this.isInPosition(index),
      legal: this.legalActions(index)
    };

    if (type === 'fold') {
      p.folded = true;
      p.acted = true;
      p.lastAction = '弃牌';
      this.addLog(`${p.name} 弃牌`, 'fold');

    } else if (type === 'check') {
      if (toCall > 0) return false;
      p.acted = true;
      p.lastAction = '过牌';
      this.addLog(`${p.name} 过牌`);

    } else if (type === 'call') {
      const put = Math.min(toCall, p.stack);
      this.moveChips(p, put);
      p.acted = true;
      p.lastAction = p.allIn ? `全下跟注 ${put}` : `跟注 ${put}`;
      this.addLog(`${p.name} 跟注 ${put}${p.allIn ? '（全下）' : ''}`, 'call');

    } else if (type === 'bet' || type === 'raise' || type === 'allin') {
      const maxTarget = p.bet + p.stack;
      let t = Math.min(Math.floor(target), maxTarget);
      if (t <= this.currentBet && t < maxTarget) return false;   // 加注必须超过当前注额

      const put = t - p.bet;
      if (put <= 0 || put > p.stack) return false;

      const raiseSize = t - this.currentBet;
      this.moveChips(p, put);
      // 只有完整加注才抬高 minRaise，短全下不改
      if (raiseSize >= this.minRaise) this.minRaise = raiseSize;
      this.currentBet = Math.max(this.currentBet, t);
      this.lastAggressor = index;

      // 有人加注，其他人重新获得行动权
      for (const q of this.players) {
        if (q.id !== index && !q.folded && !q.allIn && !q.sittingOut) q.acted = false;
      }
      p.acted = true;
      if (this.street === 'preflop') this.preflopAggressor = index;

      const verb = toCall > 0 ? '加注到' : '下注';
      p.lastAction = p.allIn ? `全下 ${t}` : `${verb} ${t}`;
      this.addLog(`${p.name} ${verb} ${t}${p.allIn ? '（全下）' : ''}`, 'raise');
    } else {
      return false;
    }

    snapshot.action = type;
    snapshot.actionLabel = p.lastAction;
    snapshot.invested = p.bet - snapshot.betBefore;
    snapshot.betAfter = p.bet;
    // 下注尺度（相对行动前底池）。复盘据此判断范围极化程度：
    // 超池/满池注偏极化，小注范围很宽
    snapshot.betRatio = snapshot.potBefore > 0
      ? snapshot.invested / snapshot.potBefore
      : 0;
    this.handHistory.push(snapshot);

    this.emit('action', { player: p, type });
    this.advance();
    return true;
  }

  // 位置标签：按到按钮位的距离判断早/中/后位
  positionLabel(index) {
    const alive = this.players.filter(p => !p.sittingOut);
    if (index === this.buttonIndex) return '按钮位';
    if (index === this.sbIndex) return '小盲位';
    if (index === this.bbIndex) return '大盲位';

    // 统计从该位到按钮位之间还有几人要行动，越少越靠后
    let after = 0;
    let i = index;
    for (let n = 0; n < this.players.length; n++) {
      i = (i + 1) % this.players.length;
      if (i === this.buttonIndex) break;
      if (!this.players[i].sittingOut) after++;
    }
    if (after === 0) return '关煞位';
    return after <= Math.floor(alive.length / 3) ? '后位' : '前位';
  }

  // 标准位置代号，用在座位编号里在座人数（不含已淘汰）
  seatCode(index) {
    const alive = this.players.filter(p => !p.sittingOut);
    const n = alive.length;
    // 把座位下标压缩到「在座」序列，让 seatToPosition 按实际人数计算
    const aliveIdx = alive.findIndex(p => p.id === index);
    const btnAliveIdx = alive.findIndex(p => p.id === this.buttonIndex);
    if (aliveIdx < 0 || btnAliveIdx < 0) return 'UTG';
    return seatToPosition(aliveIdx, btnAliveIdx, n);
  }

  // 是否有位置：翻后行动越靠后越有利。按钮位永远有位置，
  // 其余看到按钮的距离——同一手里最后行动的一方即为「有位置」。
  isInPosition(index) {
    const code = this.seatCode(index);
    return code === 'BTN' || code === 'CO';
  }

  moveChips(p, amount) {
    const put = Math.min(amount, p.stack);
    p.stack -= put;
    p.bet += put;
    p.totalBet += put;
    this.pot += put;
    if (p.stack === 0) p.allIn = true;
  }

  // 本轮下注是否结束
  bettingComplete() {
    const live = this.playersToAct();
    if (live.length === 0) return true;
    // 所有可行动玩家都已行动且投入额相等
    return live.every(p => p.acted && p.bet === this.currentBet);
  }

  advance() {
    // 只剩一人未弃牌，直接收池
    if (this.activePlayers().length === 1) {
      this.finishHand();
      return;
    }

    if (this.bettingComplete()) {
      this.nextStreet();
      return;
    }

    const next = this.nextActive(this.actingIndex);
    if (next === -1) {
      this.nextStreet();
      return;
    }
    this.actingIndex = next;
    this.emit('turn', { index: next, player: this.players[next] });
  }

  nextStreet() {
    // 结算本轮下注到底池，重置轮次状态
    for (const p of this.players) {
      p.bet = 0;
      p.acted = false;
      if (!p.folded) p.lastAction = '';
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressor = -1;

    const order = ['preflop', 'flop', 'turn', 'river', 'showdown'];
    const nextStreet = order[order.indexOf(this.street) + 1];

    if (nextStreet === 'showdown') {
      this.street = 'showdown';
      this.finishHand();
      return;
    }

    this.street = nextStreet;
    this.deck.pop();                                // 烧牌
    const n = nextStreet === 'flop' ? 3 : 1;
    for (let i = 0; i < n; i++) this.board.push(this.deck.pop());

    this.addLog(
      `—— ${STREET_LABEL[nextStreet]}：${this.board.map(cardToString).join(' ')}（底池 ${this.pot}）——`,
      'street'
    );
    this.emit('street', { street: nextStreet, board: this.board });

    // 翻牌后从按钮左手位开始行动
    if (this.playersToAct().length <= 1) {
      // 所有人都 all-in，直接跑完剩余公共牌
      this.emit('turn', { index: -1, player: null });
      setTimeout(() => this.nextStreet(), 700);
      return;
    }
    this.actingIndex = this.nextActive(this.buttonIndex);
    this.emit('turn', { index: this.actingIndex, player: this.players[this.actingIndex] });
  }

  // ---------------- 结算 ----------------
  finishHand() {
    this.handOver = true;
    for (const p of this.players) p.bet = 0;

    const contenders = this.activePlayers();

    if (contenders.length === 1) {
      const w = contenders[0];
      w.stack += this.pot;
      this.addLog(`${w.name} 赢得底池 ${this.pot}（其余玩家弃牌）`, 'win');
      this.emit('handEnd', {
        winners: [{ player: w, amount: this.pot, desc: '其余玩家弃牌' }],
        showCards: false
      });
      this.pot = 0;
      return;
    }

    // 摊牌：评估每人最佳牌型
    for (const p of contenders) {
      p.handResult = evaluate7(p.hole.concat(this.board));
    }

    const payouts = this.buildSidePots(contenders);
    const winners = [];
    for (const sp of payouts) {
      const best = sp.eligible.reduce((acc, p) => {
        if (!acc.length) return [p];
        const c = compareHands(p.handResult, acc[0].handResult);
        if (c > 0) return [p];
        if (c === 0) return acc.concat(p);
        return acc;
      }, []);

      const share = Math.floor(sp.amount / best.length);
      let remainder = sp.amount - share * best.length;
      best.forEach((p, i) => {
        // 余数按位置顺序分给最靠左的赢家
        const amt = share + (i < remainder ? 1 : 0);
        p.stack += amt;
        winners.push({
          player: p,
          amount: amt,
          desc: describeHand(p.handResult),
          potName: sp.name
        });
        this.addLog(
          `${p.name} 以【${describeHand(p.handResult)}】赢得${sp.name} ${amt}`,
          'win'
        );
      });
    }

    this.emit('handEnd', { winners, showCards: true, contenders });
    this.pot = 0;
  }

  // 按各玩家总投入切分主池与边池
  buildSidePots(contenders) {
    // 所有下注过的玩家（含已弃牌的）都要贡献筹码
    const contributors = this.players.filter(p => p.totalBet > 0);
    const levels = [...new Set(contenders.map(p => p.totalBet))].sort((a, b) => a - b);

    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of contributors) {
        amount += Math.max(0, Math.min(p.totalBet, level) - prev);
      }
      // 只有投入达到该档位且未弃牌的人有资格
      const eligible = contenders.filter(p => p.totalBet >= level);
      if (amount > 0) {
        pots.push({
          amount,
          eligible,
          name: pots.length === 0 ? '底池' : `边池${pots.length}`
        });
      }
      prev = level;
    }
    return pots;
  }
}
