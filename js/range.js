// 牌面感知的对手范围建模
//
// 上一版用 Chen 分筛选对手范围，问题是 Chen 分是「翻前」起手牌指标，
// 它无法表达「对手在 9s8s7d 这个面上下注，所以他大概率有成牌或强听牌」
// 这种牌面相关的信息。本模块改为：
//   1. 翻前用 Chen 分定初始范围（翻前它是合适的）
//   2. 翻后枚举全部候选组合，逐个评估它在当前牌面的实际强度
//   3. 按对手每街的动作给组合赋权重（下注偏极化、跟注偏中等、过牌偏弱）
//   4. 模拟时按权重抽样，而非等概率
//
// 这样「他转牌加注」会真正压缩到该牌面上的强牌与强听牌，胜率估计更贴近实战。

// 强度分档：0=空气 … 8=葫芦以上。翻后决策几乎都围绕这个分档展开
const STR = {
  AIR: 0, WEAK_DRAW: 1, WEAK_PAIR: 2, STRONG_DRAW: 3, TOP_PAIR: 4,
  TWO_PAIR: 5, SET: 6, STRAIGHT_FLUSH_CLASS: 7, MONSTER: 8
};

// 枚举所有未被占用的两张组合
function enumerateCombos(deadCards) {
  const dead = new Set(deadCards.map(c => c.rank + c.suit));
  const pool = createDeck().filter(c => !dead.has(c.rank + c.suit));
  const combos = [];
  for (let i = 0; i < pool.length - 1; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      combos.push([pool[i], pool[j]]);
    }
  }
  return combos;
}

// 评估一手牌在当前牌面的强度分档
function comboStrength(hole, board) {
  if (board.length < 3) {
    // 翻前没有牌面，退化为 Chen 分映射
    const s = chenScore(hole);
    return { tier: s >= 9 ? STR.SET : s >= 6 ? STR.TOP_PAIR : s >= 3 ? STR.WEAK_PAIR : STR.AIR, outs: 0 };
  }

  const made = evaluate7(hole.concat(board));
  const boardMax = Math.max(...board.map(c => c.rank));
  const holeRanks = hole.map(c => c.rank);

  // 听牌强度（河牌圈没有后续街，听牌归零）
  let outs = 0;
  if (board.length < 5) {
    const d = countDraws(hole, board);
    if (d.flushDraw) outs += 9;
    if (d.openEnded) outs += 8;
    else if (d.gutshot) outs += 4;
  }

  let tier;
  if (made.category >= 6) tier = STR.MONSTER;              // 葫芦、四条、同花顺
  else if (made.category >= 4) tier = STR.STRAIGHT_FLUSH_CLASS;  // 顺子、同花
  else if (made.category === 3) tier = STR.SET;
  else if (made.category === 2) tier = STR.TWO_PAIR;
  else if (made.category === 1) {
    const pairRank = made.tiebreak[0];
    const fromHole = holeRanks.includes(pairRank);
    const isPocket = holeRanks[0] === holeRanks[1];
    if (!fromHole) tier = STR.WEAK_PAIR;                   // 公共牌对子，人人都有
    else if ((isPocket && pairRank > boardMax) || pairRank === boardMax) tier = STR.TOP_PAIR;
    else tier = STR.WEAK_PAIR;
  } else {
    tier = STR.AIR;
  }

  // 听牌可以把空气/弱牌提档：强听牌在翻后的博弈价值接近中等成牌
  if (tier <= STR.WEAK_PAIR) {
    if (outs >= 8) tier = Math.max(tier, STR.STRONG_DRAW);
    else if (outs >= 4) tier = Math.max(tier, STR.WEAK_DRAW);
  }

  return { tier, outs, category: made.category };
}
// ---------------- 动作 → 强度权重 ----------------
// 每个动作给各强度档一个相对权重。数值是相对的，只影响抽样比例。
//
// 设计依据：
//  - 下注/加注的范围偏「极化」：强牌（价值）与强听牌（半诈唬）多，中等成牌少
//  - 跟注的范围偏「中等封顶」：有牌力但不足以加注，极强牌少（会加注）
//  - 过牌的范围偏弱，但也含慢打的强牌（比例很低）
//  - 弃牌不进入范围（该组合已退出）
const ACTION_WEIGHTS = {
  //            空气  弱听  弱对  强听  顶对  两对   三条  顺/花  巨牌
  bet:        [ 0.35, 0.55, 0.40, 1.30, 1.25, 1.35, 1.40, 1.45, 1.50 ],
  raise:      [ 0.20, 0.30, 0.15, 1.20, 1.15, 1.60, 1.90, 2.10, 2.30 ],
  allin:      [ 0.15, 0.25, 0.10, 1.10, 0.90, 1.50, 2.00, 2.40, 2.60 ],
  call:       [ 0.30, 0.95, 1.10, 1.25, 1.30, 1.00, 0.55, 0.45, 0.35 ],
  check:      [ 1.15, 1.05, 1.00, 0.70, 0.55, 0.45, 0.40, 0.35, 0.30 ],
  // 翻前跟注大盲：范围很宽，几乎不筛选
  limp:       [ 1.00, 1.00, 1.00, 1.00, 1.00, 0.95, 0.85, 0.80, 0.75 ]
};

// 下注尺度修正：超池/满池下注更极化（强牌与纯诈唬更多，中等牌更少）
function sizingSkew(weights, betRatio) {
  if (!betRatio || betRatio <= 0) return weights;
  const out = weights.slice();
  if (betRatio >= 0.9) {
    // 大注：抬高巨牌与空气（诈唬），压低中等成牌
    out[STR.AIR] *= 1.5;
    out[STR.WEAK_PAIR] *= 0.5;
    out[STR.TOP_PAIR] *= 0.7;
    out[STR.MONSTER] *= 1.3;
    out[STR.STRAIGHT_FLUSH_CLASS] *= 1.25;
  } else if (betRatio <= 0.35) {
    // 小注：范围很宽，中等牌与弱牌比例上升
    out[STR.WEAK_PAIR] *= 1.4;
    out[STR.TOP_PAIR] *= 1.2;
    out[STR.AIR] *= 1.2;
    out[STR.MONSTER] *= 0.8;
  }
  return out;
}

// 为某个对手构建「加权范围」：返回 { combos, weights, totalWeight, stats }
// history 是本手完整快照序列，用于取该对手每街的动作
function buildWeightedRange(opponentId, history, board, deadCards) {
  const combos = enumerateCombos(deadCards);
  const acts = history.filter(h => h.playerId === opponentId && h.action);

  // 翻前先用 Chen 分做一次硬筛（翻前它是合适的指标）
  let minChen = 0;
  const preflopActs = acts.filter(h => h.street === 'preflop');
  const pfRaises = preflopActs.filter(h => ['raise', 'bet', 'allin'].includes(h.action)).length;
  if (pfRaises >= 2) minChen = 9;
  else if (pfRaises === 1) minChen = 7;
  else if (preflopActs.some(h => h.action === 'call')) minChen = 3;

  // 翻后动作序列（用于逐档加权）
  const postActs = acts.filter(h => h.street !== 'preflop');

  const weights = [];
  let total = 0;
  const tierCount = [0, 0, 0, 0, 0, 0, 0, 0, 0];

  for (const combo of combos) {
    // 翻前硬筛：不满足开牌门槛的组合直接剔除
    if (minChen > 0 && chenScore(combo) < minChen) {
      weights.push(0);
      continue;
    }

    // 逐个翻后动作评权：用「该动作发生时可见的牌面」评估强度，
    // 而不是用最终牌面——对手在翻牌圈下注时还看不到转牌。
    //
    // 用几何平均而非直接累乘：累乘会让 1.45³ 这样复合放大，
    // 三条街之后强牌占比被推到 80%+ 的不现实水平。
    let logSum = 0, n = 0;
    for (const a of postActs) {
      const visibleBoard = board.slice(0, boardLenAtStreet(a.street));
      if (visibleBoard.length < 3) continue;
      const st = comboStrength(combo, visibleBoard);
      const table = ACTION_WEIGHTS[a.action] || ACTION_WEIGHTS.check;
      const skewed = sizingSkew(table, a.betRatio);
      logSum += Math.log(Math.max(1e-6, skewed[st.tier]));
      n++;
    }
    // 几何平均后再放大一次，保留「多街持续施压＝范围更强」的方向性，
    // 但增幅有界（指数 1.4 而非 n）
    let w = n > 0 ? Math.pow(Math.exp(logSum / n), 1.4) : 1;

    // 没有翻后动作时（例如翻前跟注后我立刻行动），权重保持 1
    weights.push(w);
    total += w;
    if (w > 0 && board.length >= 3) {
      tierCount[comboStrength(combo, board).tier] += w;
    }
  }

  // 全被筛空的兜底：退回等权重，避免模拟无法进行
  if (total <= 0) {
    for (let i = 0; i < weights.length; i++) weights[i] = 1;
    total = weights.length;
  }

  return { combos, weights, totalWeight: total, tierCount };
}

function boardLenAtStreet(street) {
  return street === 'flop' ? 3 : street === 'turn' ? 4 : street === 'river' ? 5 : 0;
}

// 按权重抽一手牌（前缀和 + 二分）；排除与已用牌冲突的组合
function sampleFromRange(range, usedSet) {
  const { combos, weights } = range;
  // 拒绝采样：最多试 60 次，落到冲突组合就重抽
  for (let attempt = 0; attempt < 60; attempt++) {
    let r = Math.random() * range.totalWeight;
    // 线性扫描在 1326 量级下足够快，且避免维护前缀和的额外内存
    let idx = -1;
    for (let i = 0; i < weights.length; i++) {
      if (weights[i] <= 0) continue;
      r -= weights[i];
      if (r <= 0) { idx = i; break; }
    }
    if (idx < 0) continue;
    const c = combos[idx];
    const k1 = c[0].rank + c[0].suit, k2 = c[1].rank + c[1].suit;
    if (usedSet.has(k1) || usedSet.has(k2)) continue;
    return c;
  }
  return null;
}

// ---------------- 面对下注的续注模型 ----------------
// 各强度档在面对某尺度下注时继续（跟注/加注）的概率。
// 依据：成牌基本都会继续；强听牌按赔率决定，注越大越可能放弃；
// 空气除少量诈唬加注外基本弃牌。
function continueProb(tier, betRatio) {
  const r = Math.max(0.1, Math.min(2, betRatio || 0.5));
  // 注越大，弱牌越难继续；用 1/(1+r) 做衰减基数
  const decay = 1 / (1 + r);

  switch (tier) {
    case STR.MONSTER:                return 0.99;
    case STR.STRAIGHT_FLUSH_CLASS:   return 0.98;
    case STR.SET:                    return 0.97;
    case STR.TWO_PAIR:               return 0.92;
    case STR.TOP_PAIR:               return 0.55 + 0.40 * decay;   // 大注下会弃掉一部分
    case STR.STRONG_DRAW:            return 0.30 + 0.60 * decay;   // 看赔率
    case STR.WEAK_PAIR:              return 0.18 + 0.50 * decay;
    case STR.WEAK_DRAW:              return 0.10 + 0.40 * decay;
    default:                         return 0.04 + 0.16 * decay;   // 空气：少量诈唬续注
  }
}

// 从加权范围派生「会跟注的子范围」，并算出隐含弃牌率。
// 这是 eqCalled 真算的基础：不再用经验折减系数，而是真的把弱牌剔掉后重算胜率。
function callingSubRange(range, board, betRatio) {
  const { combos, weights } = range;
  const subWeights = new Array(weights.length).fill(0);
  const tierCount = [0, 0, 0, 0, 0, 0, 0, 0, 0];

  let totalBefore = 0, totalAfter = 0;
  for (let i = 0; i < combos.length; i++) {
    const w = weights[i];
    if (w <= 0) continue;
    totalBefore += w;

    const st = board.length >= 3
      ? comboStrength(combos[i], board)
      : { tier: STR.WEAK_PAIR };
    const p = continueProb(st.tier, betRatio);
    const kept = w * p;
    subWeights[i] = kept;
    totalAfter += kept;
    tierCount[st.tier] += kept;
  }

  // 全被剔空时退回原范围，避免后续抽样失败
  if (totalAfter <= 0) {
    return {
      range: { combos, weights, totalWeight: range.totalWeight, tierCount: range.tierCount },
      foldRate: 0
    };
  }

  return {
    range: { combos, weights: subWeights, totalWeight: totalAfter, tierCount },
    foldRate: totalBefore > 0 ? 1 - totalAfter / totalBefore : 0
  };
}

// 范围构成摘要：告诉用户「对手这条线路大致代表什么牌」
function describeRange(range) {
  if (!range.tierCount || range.totalWeight <= 0) return '';
  const t = range.tierCount;
  const sum = t.reduce((a, b) => a + b, 0);
  if (sum <= 0) return '';

  const strong = (t[STR.TWO_PAIR] + t[STR.SET] + t[STR.STRAIGHT_FLUSH_CLASS] + t[STR.MONSTER]) / sum;
  const pairs = (t[STR.TOP_PAIR] + t[STR.WEAK_PAIR]) / sum;
  const draws = (t[STR.STRONG_DRAW] + t[STR.WEAK_DRAW]) / sum;
  const air = t[STR.AIR] / sum;

  return `强牌 ${Math.round(strong * 100)}% · 对子 ${Math.round(pairs * 100)}%`
    + ` · 听牌 ${Math.round(draws * 100)}% · 空气 ${Math.round(air * 100)}%`;
}
