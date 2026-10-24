// AI 对手决策：手牌强度 + 底池赔率 + 位置 + 性格

// 性格参数：紧手只玩强牌，松凶爱加注，跟注站几乎不加注
// sizeMult 调节加注尺度：狂人翻前就打到 4~6 倍，逼你用没成形的牌做决定
const PERSONAS = {
  tight:    { name: '紧手', openThreshold: 8.0, callThreshold: 6.0, aggression: 0.35, bluff: 0.05, sizeMult: 1,    stickiness: 0.35 },
  balanced: { name: '稳健', openThreshold: 6.5, callThreshold: 4.5, aggression: 0.5,  bluff: 0.12, sizeMult: 1,    stickiness: 0.40 },
  loose:    { name: '松凶', openThreshold: 4.0, callThreshold: 2.5, aggression: 0.75, bluff: 0.25, sizeMult: 1.15, stickiness: 0.55 },
  station:  { name: '跟注站', openThreshold: 7.0, callThreshold: 2.0, aggression: 0.15, bluff: 0.03, sizeMult: 0.9,  stickiness: 0.70 },
  // 狂人：范围接近任意两张，翻前就打大额，几乎不弃牌。练「放宽价值范围 + 3bet 回敬」
  maniac:   { name: '狂人', openThreshold: 2.0, callThreshold: 1.0, aggression: 0.95, bluff: 0.42, sizeMult: 1.75, stickiness: 0.95 },
  // 鱼：自己很少主动加注，但拿 25o 也跟到底。练「砍掉诈唬 + 顶对下满三条街」
  fish:     { name: '鱼',   openThreshold: 6.5, callThreshold: 0.0, aggression: 0.08, bluff: 0.02, sizeMult: 0.8,  stickiness: 0.90 }
};

// Chen 公式：翻牌前起手牌打分
function chenScore(hole) {
  const [a, b] = hole[0].rank >= hole[1].rank ? hole : [hole[1], hole[0]];
  const hiRank = a.rank, loRank = b.rank;

  const pointOf = r => {
    if (r === 14) return 10;
    if (r === 13) return 8;
    if (r === 12) return 7;
    if (r === 11) return 6;
    return r / 2;
  };

  let score = pointOf(hiRank);

  if (hiRank === loRank) {
    score = Math.max(score * 2, 5);            // 对子翻倍，最低 5 分
    return score;
  }
  if (a.suit === b.suit) score += 2;           // 同花

  const gap = hiRank - loRank - 1;
  if (gap === 1) score -= 1;
  else if (gap === 2) score -= 2;
  else if (gap === 3) score -= 4;
  else if (gap >= 4) score -= 5;

  // 两张都小于 Q 且连张，加 1 分（顺子潜力）
  if (gap <= 1 && hiRank < 12) score += 1;

  return Math.max(0, score);
}

// 翻牌后强度 0~1：成手牌型 + 听牌补偿
function postflopStrength(hole, board) {
  const all = hole.concat(board);
  const made = evaluate7(all);
  // 牌型基础分
  const base = [0.12, 0.30, 0.50, 0.66, 0.78, 0.85, 0.92, 0.97, 0.99, 1.0][made.category];

  let strength = base;

  // 一对要区分是否用到底牌、是否顶对
  if (made.category === 1) {
    const pairRank = made.tiebreak[0];
    const usesHole = hole.some(c => c.rank === pairRank);
    const boardMax = Math.max(...board.map(c => c.rank));
    if (!usesHole) strength = 0.22;                       // 公共牌对子，人人都有
    else if (pairRank >= boardMax) strength = 0.52;       // 顶对或超对
    else strength = 0.36;
  }
  if (made.category === 0) {
    // 高牌：两张大牌略有价值
    const hi = Math.max(hole[0].rank, hole[1].rank);
    strength = hi >= 13 ? 0.18 : 0.10;
  }

  // 听牌补偿（河牌圈没有后续街，不补）
  if (board.length < 5) {
    const outs = countDraws(hole, board);
    strength += outs.flushDraw ? 0.18 : 0;
    strength += outs.openEnded ? 0.14 : 0;
    strength += outs.gutshot ? 0.06 : 0;
  }

  return Math.min(0.99, strength);
}

// 判断听牌：同花听牌、两头顺、卡顺
function countDraws(hole, board) {
  const all = hole.concat(board);
  const res = { flushDraw: false, openEnded: false, gutshot: false };

  const suitCount = {};
  for (const c of all) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
  // 4 张同花且自己底牌参与才算真听牌
  for (const s in suitCount) {
    if (suitCount[s] === 4 && hole.some(c => c.suit === s)) res.flushDraw = true;
  }

  const ranks = [...new Set(all.map(c => c.rank))].sort((a, b) => a - b);
  const withAceLow = ranks.includes(14) ? [1].concat(ranks) : ranks;
  // 扫描 5 张窗口，窗口内有 4 张即为听顺
  for (let low = 1; low <= 10; low++) {
    const window = [low, low + 1, low + 2, low + 3, low + 4];
    const have = window.filter(r => withAceLow.includes(r)).length;
    if (have === 4) {
      const missing = window.find(r => !withAceLow.includes(r));
      // 缺中间为卡顺，缺两端为两头顺
      if (missing === window[0] || missing === window[4]) res.openEnded = true;
      else res.gutshot = true;
    }
  }
  return res;
}

// 主决策函数，返回 { type, target }
function decideAction(game, player) {
  const persona = PERSONAS[player.persona] || PERSONAS.balanced;
  const acts = game.legalActions(player.id);
  if (!acts.length) return { type: 'check' };

  const toCall = game.currentBet - player.bet;
  const potAfterCall = game.pot + toCall;
  const potOdds = toCall > 0 ? toCall / potAfterCall : 0;
  const raiseAct = acts.find(a => a.type === 'raise' || a.type === 'bet');
  const canRaise = !!raiseAct;

  let strength, equity;
  if (game.street === 'preflop') {
    const score = chenScore(player.hole);
    // Chen 分大致映射到胜率区间
    equity = Math.min(0.92, 0.25 + score * 0.045);
    strength = score / 20;
  } else {
    equity = postflopStrength(player.hole, game.board);
    strength = equity;
  }

  // 多人参与时需要更强的牌
  const opponents = game.activePlayers().length - 1;
  if (opponents > 1) equity -= 0.05 * (opponents - 1);

  const rand = Math.random();
  const bluffing = rand < persona.bluff && canRaise;

  // ---- 翻牌前：按位置标准范围决策 ----
  // 旧版用单一 Chen 门槛，UTG 和 BTN 开牌一样宽，这是最不真实的地方。
  // 现在按座位取标准范围百分比，再按性格调制。
  if (game.street === 'preflop') {
    const seat = game.seatCode(player.id);
    const notation = handNotation(player.hole);
    const base = POSITION_RANGES[seat] || POSITION_RANGES.MP;

    // 已有人加注过 ⇒ 用 3bet/跟注范围；无人加注（只有盲注）⇒ 用开池范围
    const raised = game.preflopAggressor >= 0 && game.preflopAggressor !== player.id;

    if (!raised) {
      // 还没人加注，只有盲注在池：按开池范围决定进不进
      // 注意：此时非大盲位要跟一个大盲（toCall>0）才算 limp，不能当成「面对加注」
      const openPct = adjustRangeForPersona(base.open, player.persona, 'open');
      const inOpen = openPct > 0 && topPercentRange(openPct).has(notation);
      if (canRaise && (inOpen || bluffing)) {
        return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, strength) };
      }
      if (toCall === 0) return { type: 'check' };            // 大盲免费看牌
      if (inOpen && toCall <= player.stack * 0.4) return { type: 'call' };  // 开池范围内 limp 跟大盲
      return { type: 'fold' };
    }

    // 面对加注：强牌 3bet，中等牌跟注，其余弃牌
    const threeBetPct = adjustRangeForPersona(base.threeBet, player.persona, 'threeBet');
    const callPct = adjustRangeForPersona(base.call, player.persona, 'call');
    const inThreeBet = topPercentRange(threeBetPct).has(notation);
    const inCall = topPercentRange(callPct).has(notation);

    if (inThreeBet && canRaise && rand < persona.aggression + 0.25) {
      return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, strength) };
    }
    // 跟注要同时满足范围与筹码占比（避免小牌为跟注押上过多筹码）。
    // 狂人和鱼基本不看这个比例——「加多少都跟」正是要练的对手特征
    const callCap = persona.stickiness || 0.4;
    if (inCall && toCall <= player.stack * callCap) return { type: 'call' };
    if (bluffing && inCall) return { type: 'call' };
    return { type: 'fold' };
  }

  // ---- 翻牌后 ----
  const spr = sprBucket(player.stack, game.pot);
  const board5 = classifyBoard(game.board);
  const isRiver = game.street === 'river';

  // SPR<1 极短筹码：只考虑全下或弃牌，不做半吊子下注
  if (spr.key === 'short') {
    if (equity > 0.5 && canRaise) {
      return { type: 'allin', target: raiseAct.max };
    }
    if (toCall === 0) return { type: 'check' };
    if (equity > potOdds + 0.02) return { type: 'call' };
    return { type: 'fold' };
  }

  if (toCall === 0) {
    // 无人下注：按牌面分类的持续下注频率决定，强牌价值、空气按频率诈唬
    const cbet = board5.cbetFreq;
    if (canRaise && equity > 0.6 && rand < persona.aggression + 0.35) {
      // 强牌价值下注，尺度跟牌面走
      return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, equity, board5) };
    }
    // 河牌极化：中间牌一律过牌，不做无意义下注
    if (!isRiver && canRaise && equity > 0.4 && rand < cbet * persona.aggression) {
      return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, equity, board5) };
    }
    // 空气 + 诈唬性格：低频诈唬（河牌只在有诈唬倾向时）
    if (canRaise && bluffing && equity < 0.35 && rand < cbet) {
      return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, equity, board5) };
    }
    return { type: 'check' };
  }

  // 面对下注：强牌加注榨取价值
  if (equity > 0.78 && canRaise && rand < persona.aggression + 0.2) {
    return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, equity, board5) };
  }
  // 胜率高于底池赔率就跟
  if (equity > potOdds + 0.06) return { type: 'call' };
  // MDF 防守：面对小注（≤半池）时，即使胜率略低于赔率也要防守一部分，
  // 否则会被对手用任意两张无风险剥削。用随机命中率贴合 MDF 的防守频率。
  const betRatio = game.pot > 0 ? toCall / game.pot : 1;
  if (betRatio <= 0.5 && equity > potOdds - 0.08) {
    const defendFreq = mdf(game.pot, toCall);
    if (rand < defendFreq) return { type: 'call' };
  }
  if (bluffing && equity > potOdds - 0.08) return { type: 'call' };
  return { type: 'fold' };
}

// 下注尺度：以牌面标准尺度为基准，再按牌力微调
// board5 由 classifyBoard 给出，含该牌面的建议尺度（湿面大、成对面小）
function sizeRaise(game, player, raiseAct, persona, strength, board5) {
  const pot = game.pot;
  const toCall = game.currentBet - player.bet;

  // 基准尺度：翻前或无牌面信息时用牌力档，翻后用牌面标准尺度
  let ratio;
  if (board5 && board5.size) {
    ratio = board5.size;
    // 超强牌在湿面加码收保护费，弱牌/诈唬略缩
    if (strength > 0.85) ratio = Math.min(1, ratio + 0.15);
    else if (strength < 0.4) ratio = Math.max(0.33, ratio - 0.1);
  } else {
    if (strength > 0.9) ratio = 0.85;
    else if (strength > 0.7) ratio = 0.66;
    else if (strength > 0.5) ratio = 0.5;
    else ratio = 0.4;
  }
  ratio *= 0.85 + Math.random() * 0.3;          // 加点随机，避免尺度可读
  ratio *= persona.sizeMult || 1;               // 狂人放大、跟注站缩小

  let target = game.currentBet + Math.round((pot + toCall) * ratio);
  target = Math.max(raiseAct.min, Math.min(raiseAct.max, target));

  // 剩余筹码不多时直接全下，别留零头
  if (raiseAct.max - target < game.bigBlind * 2) target = raiseAct.max;
  return target;
}
