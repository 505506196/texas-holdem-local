// AI 对手决策：手牌强度 + 底池赔率 + 位置 + 性格

// 性格参数：紧手只玩强牌，松凶爱加注，跟注站几乎不加注
const PERSONAS = {
  tight:    { name: '紧手', openThreshold: 8.0, callThreshold: 6.0, aggression: 0.35, bluff: 0.05 },
  balanced: { name: '稳健', openThreshold: 6.5, callThreshold: 4.5, aggression: 0.5,  bluff: 0.12 },
  loose:    { name: '松凶', openThreshold: 4.0, callThreshold: 2.5, aggression: 0.75, bluff: 0.25 },
  station:  { name: '跟注站', openThreshold: 7.0, callThreshold: 2.0, aggression: 0.15, bluff: 0.03 }
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

  // ---- 翻牌前 ----
  if (game.street === 'preflop') {
    const score = chenScore(player.hole);
    const isBB = player.id === game.bbIndex;

    if (toCall === 0) {
      if (canRaise && (score >= persona.openThreshold || bluffing)) {
        return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, strength) };
      }
      return { type: 'check' };
    }
    // 面对下注
    if (score >= persona.openThreshold + 2 && canRaise && rand < persona.aggression) {
      return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, strength) };
    }
    // 大盲位有折扣，跟注门槛放宽
    const threshold = isBB ? persona.callThreshold - 1 : persona.callThreshold;
    if (score >= threshold && toCall <= player.stack * 0.35) {
      return { type: 'call' };
    }
    if (bluffing && score >= threshold - 1) return { type: 'call' };
    return { type: 'fold' };
  }

  // ---- 翻牌后 ----
  if (toCall === 0) {
    // 无人下注：强牌或诈唬时主动下注
    if (canRaise && (equity > 0.55 || bluffing) && rand < persona.aggression + equity * 0.4) {
      return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, equity) };
    }
    return { type: 'check' };
  }

  // 面对下注：用胜率对比底池赔率
  if (equity > 0.78 && canRaise && rand < persona.aggression + 0.2) {
    return { type: raiseAct.type, target: sizeRaise(game, player, raiseAct, persona, equity) };
  }
  if (equity > potOdds + 0.06) return { type: 'call' };
  if (bluffing && equity > potOdds - 0.08) return { type: 'call' };
  // 便宜的跟注（不到底池 8%）偶尔看一张
  if (toCall <= game.pot * 0.08 && equity > 0.25) return { type: 'call' };
  return { type: 'fold' };
}

// 下注尺度：按底池比例，强牌下大注
function sizeRaise(game, player, raiseAct, persona, strength) {
  const pot = game.pot;
  const toCall = game.currentBet - player.bet;
  let ratio;
  if (strength > 0.9) ratio = 0.85;
  else if (strength > 0.7) ratio = 0.66;
  else if (strength > 0.5) ratio = 0.5;
  else ratio = 0.4;
  ratio *= 0.85 + Math.random() * 0.4;          // 加点随机，避免尺度可读

  let target = game.currentBet + Math.round((pot + toCall) * ratio);
  target = Math.max(raiseAct.min, Math.min(raiseAct.max, target));

  // 剩余筹码不多时直接全下，别留零头
  if (raiseAct.max - target < game.bigBlind * 2) target = raiseAct.max;
  return target;
}
