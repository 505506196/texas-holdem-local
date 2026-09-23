// 手牌复盘：范围加权胜率 + EV 计算 + GTO 战术规则引擎
//
// 与真 GTO 的差距（不要声称这是 GTO 求解）：
// 真 GTO 需要求解纳什均衡（CFR 一类算法），是范围对范围的博弈，
// 计算量远超浏览器实时能力。这里做的是「范围加权 equity + EV + 战术规则」，
// 属于剥削性分析（exploitative analysis），能抓出常见漏洞，但不是均衡解。
//
// 战术规则参考实战 GTO 复盘要点整理，核心是四个维度：
//  1. 范围优势归谁（翻前主动方 / 牌面是否配合其范围）
//  2. 牌面纹理（干燥 or 潮湿、是否有公对、是否成顺成花）
//  3. 行动线路（主动方 or 被动方、对手是否连续过牌、是否连续下注）
//  4. 阻断牌效应（我的牌是否阻断对手的坚果组合）

const MC_ITERATIONS = 3000;

// ---------------- 对手范围模型 ----------------
const RANGE_TIER = {
  passive:   { minChen: 0,  label: '宽范围（只过牌/跟注）' },
  caller:    { minChen: 4,  label: '中等范围（跟注）' },
  raiser:    { minChen: 7,  label: '偏强范围（有加注）' },
  aggressor: { minChen: 9,  label: '强范围（多次加注）' }
};

function inferOpponentTier(history, playerId) {
  const acts = (history || []).filter(h => h.playerId === playerId);
  if (!acts.length) return 'passive';
  let raises = 0, calls = 0;
  for (const a of acts) {
    if (a.action === 'raise' || a.action === 'bet' || a.action === 'allin') raises++;
    else if (a.action === 'call') calls++;
  }
  if (raises >= 2) return 'aggressor';
  if (raises === 1) return 'raiser';
  if (calls >= 1) return 'caller';
  return 'passive';
}

function drawFromRange(pool, taken, minChen) {
  for (let attempt = 0; attempt < 40; attempt++) {
    let i, j;
    do { i = randomInt(pool.length); } while (taken.has(i));
    do { j = randomInt(pool.length); } while (taken.has(j) || j === i);
    const hole = [pool[i], pool[j]];
    if (minChen <= 0 || chenScore(hole) >= minChen) {
      taken.add(i); taken.add(j);
      return hole;
    }
  }
  let i, j;
  do { i = randomInt(pool.length); } while (taken.has(i));
  do { j = randomInt(pool.length); } while (taken.has(j) || j === i);
  taken.add(i); taken.add(j);
  return [pool[i], pool[j]];
}

function rangeEquity(hole, board, opponentTiers, iterations) {
  const iter = iterations || MC_ITERATIONS;
  if (!opponentTiers.length) return { equity: 1, win: 1, tie: 0 };

  const used = new Set(hole.concat(board).map(c => c.rank + c.suit));
  const pool = createDeck().filter(c => !used.has(c.rank + c.suit));
  const boardNeed = 5 - board.length;

  let win = 0, tie = 0;
  for (let it = 0; it < iter; it++) {
    const taken = new Set();
    const extra = [];
    for (let k = 0; k < boardNeed; k++) {
      let idx;
      do { idx = randomInt(pool.length); } while (taken.has(idx));
      taken.add(idx);
      extra.push(pool[idx]);
    }
    const fullBoard = board.concat(extra);
    const mine = evaluate7(hole.concat(fullBoard));

    let result = 0;
    for (const tier of opponentTiers) {
      const oppHole = drawFromRange(pool, taken, RANGE_TIER[tier].minChen);
      const opp = evaluate7(oppHole.concat(fullBoard));
      const c = compareHands(mine, opp);
      if (c < 0) { result = 1; break; }
      if (c === 0) result = 2;
    }
    if (result === 0) win++;
    else if (result === 2) tie++;
  }
  return { win: win / iter, tie: tie / iter, equity: (win + tie / 2) / iter };
}

// 牌面感知的胜率：对手按「动作加权范围」抽牌，而非 Chen 分硬筛。
// 这是准确度的主要来源——对手的下注线路会真正压缩到该牌面上的合理持牌。
// 回退策略：范围构建失败或抽样连续失败时退回 rangeEquity，保证总能出结果。
function weightedEquity(hole, board, opponentIds, history, iterations) {
  const iter = iterations || MC_ITERATIONS;
  if (!opponentIds.length) return { equity: 1, win: 1, tie: 0, ranges: [] };

  const dead = hole.concat(board);
  let ranges;
  try {
    ranges = opponentIds.map(id => buildWeightedRange(id, history, board, dead));
  } catch (e) {
    const tiers = opponentIds.map(id => inferOpponentTier(history, id));
    return { ...rangeEquity(hole, board, tiers, iter), ranges: [], fallback: true };
  }

  const used0 = new Set(dead.map(c => c.rank + c.suit));
  const pool = createDeck().filter(c => !used0.has(c.rank + c.suit));
  const boardNeed = 5 - board.length;

  let win = 0, tie = 0, valid = 0;
  for (let it = 0; it < iter; it++) {
    const used = new Set(used0);

    // 补公共牌
    const extra = [];
    let ok = true;
    for (let k = 0; k < boardNeed; k++) {
      let card = null;
      for (let t = 0; t < 30; t++) {
        const c = pool[randomInt(pool.length)];
        const key = c.rank + c.suit;
        if (!used.has(key)) { used.add(key); card = c; break; }
      }
      if (!card) { ok = false; break; }
      extra.push(card);
    }
    if (!ok) continue;

    const fullBoard = board.concat(extra);
    const mine = evaluate7(hole.concat(fullBoard));

    let result = 0;
    for (const range of ranges) {
      const oppHole = sampleFromRange(range, used);
      if (!oppHole) { ok = false; break; }
      used.add(oppHole[0].rank + oppHole[0].suit);
      used.add(oppHole[1].rank + oppHole[1].suit);
      const opp = evaluate7(oppHole.concat(fullBoard));
      const c = compareHands(mine, opp);
      if (c < 0) { result = 1; break; }
      if (c === 0) result = 2;
    }
    if (!ok) continue;

    valid++;
    if (result === 0) win++;
    else if (result === 2) tie++;
  }

  // 有效样本太少说明范围过窄，退回旧模型而不是给出噪声数字
  if (valid < iter * 0.2) {
    const tiers = opponentIds.map(id => inferOpponentTier(history, id));
    return { ...rangeEquity(hole, board, tiers, iter), ranges, fallback: true };
  }

  return {
    win: win / valid,
    tie: tie / valid,
    equity: (win + tie / 2) / valid,
    samples: valid,
    ranges
  };
}
// ---------------- 牌面纹理 ----------------
function boardTexture(board) {
  if (board.length < 3) {
    return { wet: 0, label: '', hasAce: false, paired: false, flushDraw: false,
             madeFlush: false, straightish: false, maxSuit: 0 };
  }

  const suits = {};
  for (const c of board) suits[c.suit] = (suits[c.suit] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suits));

  const ranks = [...new Set(board.map(c => c.rank))].sort((a, b) => a - b);
  let gaps = 0;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] - ranks[i - 1] <= 2) gaps++;
  }
  const paired = board.length !== new Set(board.map(c => c.rank)).size;
  const hasAce = board.some(c => c.rank === 14);

  // 牌面本身是否已成顺（天顺面）——此时中等成牌价值大幅下降
  let straightish = false;
  for (let lo = 1; lo <= 10; lo++) {
    const win = [lo, lo + 1, lo + 2, lo + 3, lo + 4];
    const withAceLow = ranks.includes(14) ? [1].concat(ranks) : ranks;
    if (win.filter(r => withAceLow.includes(r)).length >= 4) { straightish = true; break; }
  }

  let wet = 0;
  if (maxSuit >= 4) wet += 0.6;
  else if (maxSuit === 3) wet += 0.42;
  else if (maxSuit === 2) wet += 0.12;
  wet += Math.min(0.36, gaps * 0.16);
  if (paired) wet += 0.1;
  wet = Math.min(1, wet);

  const label = wet > 0.58 ? '潮湿牌面' : wet > 0.3 ? '中性牌面' : '干燥牌面';
  return {
    wet, label, hasAce, paired, maxSuit,
    flushDraw: maxSuit === 3,
    madeFlush: maxSuit >= 4,
    straightish
  };
}

// ---------------- 我的牌力分档 ----------------
// GTO 决策高度依赖「我的成牌处在范围的哪个位置」，而非单纯胜率数字
function classifyHand(hole, board) {
  if (board.length < 3) {
    const s = chenScore(hole);
    const pair = hole[0].rank === hole[1].rank;
    return {
      tier: s >= 10 ? 'nuts' : s >= 7 ? 'strong' : s >= 4 ? 'medium' : 'air',
      label: pair ? `口袋对 ${RANK_LABEL[hole[0].rank]}` : '起手牌',
      isPocketPairLike: pair, capped: false, nutty: s >= 12
    };
  }

  const made = evaluate7(hole.concat(board));
  const boardMax = Math.max(...board.map(c => c.rank));
  const holeRanks = hole.map(c => c.rank);
  const usesHole = h => h.some(r => board.some(b => b.rank === r));

  let tier, label, capped = false, nutty = false;

  if (made.category >= 6) {            // 葫芦以上
    tier = 'nuts'; label = describeHand(made); nutty = true;
  } else if (made.category === 5 || made.category === 4) {
    tier = 'strong'; label = describeHand(made);
    // 成顺成花但牌面更大听牌存在时不算坚果
    nutty = true;
  } else if (made.category === 3) {
    // 三条：要区分暗三（底牌成对）与明三（用公对）
    const tripRank = made.tiebreak[0];
    const inHole = holeRanks.filter(r => r === tripRank).length;
    tier = 'strong';
    label = inHole === 2 ? `暗三条 ${RANK_LABEL[tripRank]}` : `明三条 ${RANK_LABEL[tripRank]}`;
  } else if (made.category === 2) {
    tier = 'medium'; label = describeHand(made);
  } else if (made.category === 1) {
    const pairRank = made.tiebreak[0];
    const fromHole = holeRanks.includes(pairRank);
    const isPocket = holeRanks[0] === holeRanks[1];
    if (!fromHole) {
      // 公共牌的对子，人人都有
      tier = 'weak'; label = '牌面公对（未用到底牌）'; capped = true;
    } else if (isPocket && pairRank > boardMax) {
      tier = 'medium'; label = `超对 ${RANK_LABEL[pairRank]}`; capped = true;
    } else if (pairRank === boardMax) {
      const kicker = made.tiebreak[1];
      const topKicker = kicker >= 13;
      tier = topKicker ? 'medium' : 'medium';
      label = `顶对${topKicker ? '大踢脚' : '小踢脚'}`;
      capped = !topKicker;
    } else if (isPocket) {
      tier = 'weak'; label = `被压的口袋对 ${RANK_LABEL[pairRank]}`; capped = true;
    } else {
      tier = 'weak'; label = '中/底对'; capped = true;
    }
  } else {
    // 高牌：看是否两高张
    const highs = holeRanks.filter(r => r >= 12).length;
    tier = 'air';
    label = highs >= 2 ? '两高张未成牌' : '空气牌';
  }

  // isPocketPairLike：口袋对或超对，规则里判断「牌面有 A 时超对降级」要用
  const isPocketPairLike = holeRanks[0] === holeRanks[1];
  return { tier, label, capped, nutty, isPocketPairLike, category: made.category, made };
}

// 我的听牌与阻断牌
function myDraws(hole, board) {
  if (board.length < 3 || board.length >= 5) {
    return { has: false, outs: 0, label: '', nutFlushBlocker: false };
  }
  const d = countDraws(hole, board);
  let outs = 0;
  const parts = [];
  if (d.flushDraw) { outs += 9; parts.push('同花听牌'); }
  if (d.openEnded) { outs += 8; parts.push('两头顺听牌'); }
  else if (d.gutshot) { outs += 4; parts.push('卡顺听牌'); }

  // 阻断牌：我是否持有对手坚果同花所需的关键牌（通常是 A 或 K 同色）
  const suits = {};
  for (const c of board) suits[c.suit] = (suits[c.suit] || 0) + 1;
  let nutFlushBlocker = false;
  for (const s in suits) {
    if (suits[s] >= 3) {
      if (hole.some(c => c.suit === s && (c.rank === 14 || c.rank === 13))) nutFlushBlocker = true;
    }
  }
  return { has: outs > 0, outs, label: parts.join(' + '), nutFlushBlocker, raw: d };
}
// ---------------- 战术规则引擎 ----------------
// 每条规则检查一个具体场景，命中则给出建议动作 + 理由。
// 规则按优先级排序：越靠前越特殊、越具体。
// 规则设计依据实战 GTO 复盘的核心原则，注释里标明该规则对应的原则。

const TACTIC_RULES = [

  // —— 被动方不要反主动下注（donk bet）——
  {
    id: 'no-donk-bet',
    test: c => !c.isPFA && !c.facingBet && c.wantsBet && c.street !== 'preflop'
      && c.handTier !== 'nuts',
    advise: c => ({
      type: 'check',
      reason: '你是翻前被动方。被动方在翻牌圈反主动下注（donk bet）通常不利：'
        + '主动权在对手手上，过牌把决策权交还给他，既能控池也能看他下一步',
      principle: '翻前被动方不建议反主动下注'
    })
  },

  // —— 牌面有 A 时，KK/QQ 这类超对牌力下降 ——
  {
    id: 'ace-on-board-caution',
    test: c => c.texture.hasAce && c.hand.isPocketPairLike
      && c.handTier === 'medium' && c.wantsBet && !c.facingBet,
    advise: c => ({
      type: 'check',
      reason: '牌面有 A，对手范围里有大量 Ax 组合能跟注甚至反超你，'
        + '这手超对的价值下降到「中等成牌」，不足以价值下注。过牌控池更稳',
      principle: '牌面有 A 时大口袋对牌力不足以价值下注'
    })
  },

  // —— 对手翻牌跟注后，转牌牌力没提升就别再下第二枪 ——
  {
    id: 'turn-give-up',
    test: c => c.street === 'turn' && c.oppCalledLastStreet && c.wantsBet
      && (c.handTier === 'medium' || c.hand.capped) && !c.draws.has,
    advise: c => ({
      type: 'check',
      reason: '对手在翻牌圈跟注已经表明有一定牌力，而你转牌没有提升。'
        + '继续价值下注既难让更弱牌跟，也难让更强牌弃，还要承担被加注的风险',
      principle: '对手翻牌跟注后，牌力不足不要二次价值下注'
    })
  },

  // —— 对手连续过牌 ⇒ 范围弱，该薄价值下注或诈唬 ——
  {
    id: 'exploit-passive-line',
    test: c => c.oppCheckedTwice && !c.facingBet && !c.wantsBet
      && c.street !== 'preflop',
    advise: c => {
      const thin = c.handTier === 'medium' || c.handTier === 'strong';
      return {
        type: 'bet',
        size: thin ? '1/3 ~ 1/2 池（薄价值）' : '1/2 池（诈唬）',
        reason: thin
          ? '对手连续过牌，范围明显偏弱。你有一定摊牌价值，应该薄价值下注，'
            + '一味过牌会损失这部分价值'
          : '对手连续过牌，范围偏弱且难以跟注。你没有摊牌价值，'
            + '下注诈唬的期望优于过牌摊牌',
        principle: '对手连续过牌代表范围弱，应主动薄价值或诈唬'
      };
    }
  },

  // —— 干燥牌面多人底池不要半诈唬 ——
  {
    id: 'no-semibluff-dry-multiway',
    test: c => c.opponents >= 2 && c.texture.wet < 0.3 && c.wantsBet
      && (c.handTier === 'air' || c.draws.outs <= 4) && !c.facingBet,
    advise: c => ({
      type: 'check',
      reason: `${c.opponents} 家对手且牌面干燥，半诈唬很难打走所有人，`
        + '多人底池里至少有一家会带着对子跟注。这种牌面应该放弃诈唬',
      principle: '干燥牌面多人底池不要半诈唬'
    })
  },

  // —— 强听牌 + 潮湿牌面 ⇒ 半诈唬（尤其湿的正好是我的听牌）——
  {
    id: 'semibluff-wet-with-draw',
    test: c => c.draws.outs >= 8 && !c.facingBet && c.street !== 'river'
      && c.opponents === 1,
    advise: c => ({
      type: 'bet',
      size: c.texture.wet > 0.55 ? '2/3 ~ 满池' : '1/2 池',
      reason: `你持 ${c.draws.label}（约 ${c.draws.outs} 张补牌），`
        + '牌面的潮湿正好是你的听牌方向。半诈唬既有击中的空间，'
        + '也有可观的弃牌率，比被动过牌好',
      principle: '牌面潮湿且湿的正是我的听牌时应半诈唬'
    })
  },

  // —— 多人底池强听牌要快打 ——
  {
    id: 'fastplay-draw-multiway',
    test: c => c.opponents >= 2 && c.draws.outs >= 8 && !c.facingBet,
    advise: c => ({
      type: 'bet',
      size: '2/3 池',
      reason: `多人底池里持 ${c.draws.label} 应该快打：`
        + '底池已经很大，直接建立底池并压缩对手范围，比等着被动跟注更好',
      principle: '多人底池遇到强听牌要快打'
    })
  },

  // —— 坚果牌 + 牌面转湿 ⇒ 快打收保护费 ——
  {
    id: 'fastplay-nuts-wet',
    test: c => c.hand.nutty && c.texture.wet > 0.5 && !c.facingBet,
    advise: c => ({
      type: 'bet',
      size: '2/3 ~ 满池',
      reason: `你的 ${c.hand.label} 已是范围顶端，但牌面潮湿（${c.texture.label}）。`
        + '必须快打收取价值兼收保护费，否则河牌来惊悚张会损失整个底池',
      principle: '强牌在牌面变湿后要激进快打'
    })
  },

  // —— 坚果牌 + 干燥牌面 ⇒ 可以慢打 ——
  {
    id: 'slowplay-nuts-dry',
    test: c => c.hand.nutty && c.texture.wet < 0.3 && !c.facingBet
      && c.opponents === 1 && c.oppTier !== 'passive',
    advise: c => ({
      type: 'check',
      reason: `你的 ${c.hand.label} 在这个干燥牌面几乎不可能被反超，`
        + '而且你阻断了对手很多能跟注的组合。过牌慢打诱使对手主动进攻，'
        + '比直接下注赶走他更能榨取价值',
      principle: '有坚果且牌面干燥、对手激进时可以慢打'
    })
  },

  // —— 被盖帽的牌面公对 / 底对不需要保护，也别下注 ——
  {
    id: 'capped-no-protection',
    test: c => c.hand.capped && c.opponents === 1 && c.texture.wet < 0.35
      && c.wantsBet && !c.facingBet,
    advise: c => ({
      type: 'check',
      reason: `${c.hand.label} 在单挑干燥牌面不容易被反超，不需要下注保护。`
        + '这类中等牌力更适合游戏小底池，过牌既控池也保护了你的过牌范围',
      principle: '单挑底池被盖帽的牌不需要下注保护'
    })
  },

  // —— 面对连续下注的强线路：除非坚果否则别加注 ——
  {
    id: 'dont-raise-vs-polarized',
    test: c => c.oppBetTwice && c.facingBet && c.wantsRaise && !c.hand.nutty,
    advise: c => ({
      type: 'call',
      reason: '对手连续下注多条街，范围已经相当极化（要么坚果要么纯诈唬）。'
        + '你不是坚果，加注会把更弱的诈唬牌赶走、只留下能打败你的牌。跟注即可',
      principle: '对手连续下注后范围极化，非坚果不要加注'
    })
  },

  // —— 天顺面 / 已成花的牌面，中等成牌要谨慎 ——
  {
    id: 'made-board-caution',
    test: c => (c.texture.straightish || c.texture.madeFlush)
      && (c.handTier === 'medium' || c.hand.capped) && c.facingBet && c.opponents >= 2,
    advise: c => ({
      type: 'fold',
      reason: `牌面已经${c.texture.madeFlush ? '成同花' : '有成顺可能'}，`
        + `你只有 ${c.hand.label}。多人底池有人下注意味着很可能已被击败，`
        + '反向隐含赔率很高，继续投入是亏的',
      principle: '多人底池牌面极湿时，中等成牌也要弃牌'
    })
  },

  // —— 小听牌 + 公对面 / 更大听牌存在 ⇒ 隐含赔率不足 ——
  {
    id: 'weak-draw-bad-implied',
    test: c => c.draws.has && c.draws.outs <= 8 && c.facingBet
      && c.opponents >= 2 && (c.texture.paired || c.texture.madeFlush),
    advise: c => ({
      type: 'fold',
      reason: `你持 ${c.draws.label}，但牌面${c.texture.paired ? '有公对（对手可能已成葫芦）' : '已成同花'}。`
        + '净补牌远少于名义 outs，即使击中也可能输更大的底池，反向隐含赔率过高',
      principle: '听牌在公对面/更大听牌面隐含赔率不足应弃牌'
    })
  },

  // —— 有阻断牌时更适合慢打而非加注 ——
  {
    id: 'blocker-slowplay',
    test: c => c.draws.nutFlushBlocker && c.hand.nutty && c.facingBet && c.wantsRaise,
    advise: c => ({
      type: 'call',
      reason: '你手里的高张同色阻断了对手的坚果同花组合，'
        + '这意味着他能跟注加注的强牌更少了。跟注慢玩能保护你的跟注范围，'
        + '也避免把他的弱范围赶走',
      principle: '持阻断牌时慢玩优于加注'
    })
  },

  // —— 面对小尺度下注不要过度弃牌 ——
  {
    id: 'dont-overfold-small-bet',
    // 守卫只看赔率，不看成牌分档：两高张未成牌会被归为 air，
    // 但面对小注时它照样有足够权益继续，用 handTier 当门禁会让规则永不命中
    test: c => c.facingBet && c.betRatio <= 0.3 && c.wantsFold
      && (c.equity > c.needEquity || c.draws.has),
    advise: c => ({
      type: 'call',
      reason: `对手只下了约 ${Math.round(c.betRatio * 100)}% 底池，范围很宽。`
        + `底池赔率只要 ${pct(c.needEquity)} 胜率就够，而你有 ${pct(c.equity)}`
        + `（${c.hand.label}${c.draws.has ? ' + ' + c.draws.label : ''}），`
        + '直接弃牌防守严重不足'
        + (c.equity > c.needEquity + 0.18 && c.canRaise
          ? '。事实上你的权益远超门槛，这里加注施压比只跟注更好' : ''),
      principle: '面对小尺度下注不要过度弃牌'
    })
  },

  // —— 无摊牌价值 + 想诈唬 ⇒ 潮湿河牌要下大注 ——
  {
    id: 'bluff-big-on-wet-river',
    test: c => c.street === 'river' && c.handTier === 'air' && c.wantsBet
      && c.texture.wet > 0.5,
    advise: c => ({
      type: 'bet',
      size: '满池或超池',
      reason: '你完全没有摊牌价值，河牌诈唬要给足压力。'
        + '潮湿牌面上小注既打不走对手的成牌，还容易被反诈唬，要么下大注要么放弃',
      principle: '河牌潮湿面诈唬要下大注'
    })
  },

  // —— 中等成牌不要转诈唬 ——
  {
    id: 'no-bluff-with-showdown-value',
    test: c => c.street === 'river' && c.handTier === 'medium' && c.wantsBet
      && c.oppTier !== 'passive',
    advise: c => ({
      type: 'check',
      reason: `${c.hand.label} 有实际摊牌价值。把它转成诈唬是双重浪费：`
        + '既放弃了赢下摊牌的机会，又让你的诈唬范围过载。过牌摊牌就好',
      principle: '中等强度成牌不要转诈唬'
    })
  }
];

// 逐条匹配规则，返回第一条命中的
function applyTactics(ctx) {
  for (const rule of TACTIC_RULES) {
    try {
      if (rule.test(ctx)) {
        const out = rule.advise(ctx);
        return { ...out, ruleId: rule.id };
      }
    } catch (e) {
      // 单条规则出错不能影响整体复盘
      continue;
    }
  }
  return null;
}
const ADVICE_LABEL = {
  fold: '弃牌', check: '过牌', call: '跟注', bet: '下注', raise: '加注'
};

// ---------------- 基线建议（纯数学：胜率 vs 赔率）----------------
// 规则引擎没命中时用这个兜底
function baselineAdvice(c) {
  const { equity, effectiveEquity, needEquity, toCall, canRaise,
          inPosition, texture, draws, opponents, callEV, pot } = c;

  // 多人折价：原来每多一家扣 4 个点，叠加后过重
  // （4 家对手扣 12 点，直接把大量边际跟注推成弃牌）。
  // 改为递减式——第二家扣得多，之后每家递减，且总折价封顶 7 个点。
  const penalty = opponents > 1
    ? Math.min(0.07, 0.03 + 0.015 * (opponents - 2))
    : 0;
  const eqAdj = equity - penalty;

  if (toCall === 0) {
    // 无人下注时的价值下注门槛下调 5 个点：错过价值下注的代价
    // 通常高于被加注的代价，尤其有位置时
    const threshold = inPosition ? 0.53 : 0.58;
    if (eqAdj > threshold && canRaise) {
      const size = texture.wet > 0.55 ? '2/3 ~ 3/4 池' : '1/3 ~ 1/2 池';
      // 给出具体金额，省得用户自己按比例换算
      const lo = Math.round(pot * (texture.wet > 0.55 ? 0.66 : 0.33));
      const hi = Math.round(pot * (texture.wet > 0.55 ? 0.75 : 0.5));
      return {
        type: 'bet', size,
        reason: `胜率 ${pct(equity)} 领先${inPosition ? '且有位置' : ''}，`
          + `应价值下注。底池 ${pot}，${texture.label}建议下 ${size}`
          + `（约 ${lo} ~ ${hi} 筹码）`
      };
    }
    if (eqAdj > 0.45) {
      return { type: 'check', reason: `胜率 ${pct(equity)} 中等，过牌控池` };
    }
    return { type: 'check', reason: `胜率 ${pct(equity)} 偏低，过牌免费看牌` };
  }

  if (eqAdj > needEquity + 0.14 && canRaise) {
    // 加注到对手注额的 2.5~3 倍，并算出加注后对手面对的赔率，
    // 让用户知道这个尺度能给对手多大压力
    const mult = texture.wet > 0.55 ? 3 : 2.5;
    const target = Math.round(toCall * mult);
    const oppFaces = target - toCall;                 // 对手还需补的金额
    const oppPot = pot + toCall + target;             // 对手跟注后的底池
    const oppNeed = oppPot > 0 ? oppFaces / (oppPot + oppFaces) : 0;
    return {
      type: 'raise',
      size: `加注到 ${target}（${mult} 倍）`,
      reason: `胜率 ${pct(equity)} 超出赔率门槛 ${pct(needEquity)} 约 `
        + `${pct(eqAdj - needEquity)}，应加注榨取价值。`
        + `加注到 ${target} 后对手需再补 ${oppFaces}，他的门槛升到 ${pct(oppNeed)}`
        + `${texture.wet > 0.55 ? '；牌面潮湿，用 3 倍收保护费' : ''}`
    };
  }
  if (eqAdj > needEquity + 0.02) {
    return {
      type: 'call',
      reason: `胜率 ${pct(equity)} 高于赔率门槛 ${pct(needEquity)}，`
        + `跟注 ${toCall} 的期望值约 ${callEV >= 0 ? '+' : ''}${callEV.toFixed(0)} 筹码`
        + `（${pct(equity)} × ${pot + toCall} − ${toCall}）`
    };
  }
  if (draws.has && effectiveEquity > needEquity + 0.02) {
    return {
      type: 'call',
      reason: `即时胜率 ${pct(equity)} 略低于门槛 ${pct(needEquity)}，但持 `
        + `${draws.label}（${draws.outs} outs），算上隐含赔率有效胜率约 `
        + `${pct(effectiveEquity)}，跟注可行`
    };
  }
  // 边际区间从 3 个点放宽到 6 个点：这一段跟注的实际 EV 接近 0，
  // 但跟注能保护范围、避免被小注反复剥削，长期优于一律弃牌
  if (eqAdj > needEquity - 0.06) {
    return {
      type: 'call',
      reason: `胜率 ${pct(equity)} 与门槛 ${pct(needEquity)} 接近，`
        + `跟注 EV 约 ${callEV >= 0 ? '+' : ''}${callEV.toFixed(0)} 筹码。`
        + '这段边际区间倾向跟注：一律弃牌会让对手用小注无限剥削你'
    };
  }
  // 面对小注（不到 1/3 池）时进一步放宽：赔率好，弃牌代价大
  if (toCall <= pot * 0.34 && eqAdj > needEquity - 0.10) {
    return {
      type: 'call',
      reason: `对手只下了 ${Math.round(toCall / pot * 100)}% 底池，`
        + `门槛低至 ${pct(needEquity)}。你的 ${pct(equity)} 虽略低，`
        + '但面对小注过度弃牌是常见漏洞，这里应该防守'
    };
  }
  return {
    type: 'fold',
    reason: `胜率 ${pct(equity)} 低于赔率门槛 ${pct(needEquity)}`
      + `，差 ${pct(needEquity - eqAdj)}`
      + `${opponents > 1 ? `（${opponents} 家对手已折价 ${pct(penalty)}）` : ''}，`
      + `跟注 EV 约 ${callEV.toFixed(0)} 筹码，长期亏损`
  };
}

// ---------------- 单个决策点评价 ----------------
function reviewDecision(snap, history) {
  const tiers = (snap.liveOpponentIds || []).map(id => inferOpponentTier(history, id));
  const tierList = tiers.length ? tiers : ['passive'];

  // 牌面感知范围优先；它内部会在范围过窄时自动回退到 Chen 分模型
  const eq = weightedEquity(snap.hole, snap.board, snap.liveOpponentIds || [], history);
  const equity = eq.equity;
  const rangeDesc = (eq.ranges && eq.ranges[0]) ? describeRange(eq.ranges[0]) : '';

  const toCall = snap.toCall;
  const pot = snap.potBefore;
  const texture = boardTexture(snap.board);
  const hand = classifyHand(snap.hole, snap.board);
  const draws = myDraws(snap.hole, snap.board);

  const needEquity = toCall > 0 ? toCall / (pot + toCall) : 0;
  const callEV = toCall > 0 ? equity * (pot + toCall) - toCall : 0;

  // 隐含赔率：听牌击中后还能多赢一部分
  let impliedBonus = 0;
  if (draws.has && toCall > 0 && snap.street !== 'river') {
    const streetsLeft = snap.street === 'flop' ? 2 : 1;
    const hitChance = Math.min(0.45, draws.outs * 0.02 * streetsLeft);
    // 公对面/已成花时净补牌打折（反向隐含赔率）
    const discount = (texture.paired || texture.madeFlush) ? 0.35 : 1;
    impliedBonus = hitChance * 0.5 * discount;
  }
  const effectiveEquity = Math.min(0.97, equity + impliedBonus);

  const canRaise = snap.legal.some(a => a.type === 'raise' || a.type === 'bet');
  const inPosition = ['按钮位', '关煞位', '后位'].includes(snap.position);

  // 线路特征：对手本街/上街的行为模式
  const line = analyzeLine(snap, history);

  // 构造规则引擎的上下文
  const ctx = {
    street: snap.street,
    equity, effectiveEquity, needEquity, toCall, pot, callEV,
    canRaise, inPosition,
    texture, hand, draws,
    handTier: hand.tier,
    opponents: tierList.length,
    oppTier: tierList[0],
    isPFA: !!snap.isPreflopAggressor,
    facingBet: toCall > 0,
    betRatio: pot > 0 ? toCall / pot : 0,
    // 玩家实际想做什么——规则要判断「这个动作对不对」，所以要知道他选了什么
    wantsBet: snap.action === 'bet' || snap.action === 'raise' || snap.action === 'allin',
    wantsRaise: snap.action === 'raise' || snap.action === 'allin',
    wantsFold: snap.action === 'fold',
    wantsCheck: snap.action === 'check',
    oppCheckedTwice: line.oppCheckedTwice,
    oppCalledLastStreet: line.oppCalledLastStreet,
    oppBetTwice: line.oppBetTwice
  };

  // 规则优先，没命中才用纯数学基线
  const tactic = applyTactics(ctx);
  const advice = tactic || baselineAdvice(ctx);

  // 各动作的 EV 对比，让「为什么该这样打」变成可核对的数字
  const evTable = buildEvTable({
    equity, effectiveEquity, pot, toCall, canRaise, texture, draws,
    oppRange: eq.ranges && eq.ranges[0],
    hole: snap.hole,
    board: snap.board
  });

  const grade = gradeAction(snap.action, advice.type, {
    equity, effectiveEquity, needEquity, toCall, pot, callEV, draws, hand
  });

  return {
    street: snap.street,
    streetLabel: STREET_LABEL[snap.street] || snap.street,
    board: snap.board,
    hole: snap.hole,
    position: snap.position,
    opponents: tierList.length,
    oppRanges: tierList.map(t => RANGE_TIER[t].label),
    textureLabel: texture.label,
    handLabel: hand.label,
    drawLabel: draws.label,
    outs: draws.outs,
    isPFA: ctx.isPFA,
    rangeDesc,
    usedFallback: !!eq.fallback,
    samples: eq.samples || MC_ITERATIONS,
    evTable,
    pot, toCall,
    equity, effectiveEquity, impliedBonus, needEquity, callEV,
    actual: snap.action,
    actualLabel: actionLabel(snap),
    advice: advice.type,
    adviceLabel: ADVICE_LABEL[advice.type],
    adviceReason: advice.reason,
    adviceSize: advice.size || null,
    principle: advice.principle || null,
    ruleId: advice.ruleId || null,
    grade: grade.tag,
    gradeNote: grade.note,
    evLoss: grade.evLoss
  };
}

// 对抗「已收紧的子范围」重算胜率。
// 这替代了原来的经验折减系数：对手跟注后弱牌已被剔除，
// 直接对剩下的子范围跑一次加权模拟，得到的 eqCalled 与跟注行同等可信。
// 迭代数取较小值（子范围窄、方差低），保证面板响应速度。
function equityVsSubRange(hole, board, subRange, iterations) {
  // 子范围窄、方差本应较低，但单挑场景下仍会波动到突破上界，
  // 所以轮次取 2400 而非更省的 1200
  const iter = iterations || 2400;
  if (!subRange || subRange.totalWeight <= 0) return null;

  const used0 = new Set(hole.concat(board).map(c => c.rank + c.suit));
  const pool = createDeck().filter(c => !used0.has(c.rank + c.suit));
  const boardNeed = 5 - board.length;

  let win = 0, tie = 0, valid = 0;
  for (let it = 0; it < iter; it++) {
    const used = new Set(used0);

    const extra = [];
    let ok = true;
    for (let k = 0; k < boardNeed; k++) {
      let card = null;
      for (let t = 0; t < 30; t++) {
        const c = pool[randomInt(pool.length)];
        const key = c.rank + c.suit;
        if (!used.has(key)) { used.add(key); card = c; break; }
      }
      if (!card) { ok = false; break; }
      extra.push(card);
    }
    if (!ok) continue;

    const oppHole = sampleFromRange(subRange, used);
    if (!oppHole) continue;

    const fullBoard = board.concat(extra);
    const mine = evaluate7(hole.concat(fullBoard));
    const opp = evaluate7(oppHole.concat(fullBoard));
    const c = compareHands(mine, opp);

    valid++;
    if (c > 0) win++;
    else if (c === 0) tie++;
  }

  if (valid < iter * 0.2) return null;
  return (win + tie / 2) / valid;
}

// ---------------- 多动作 EV 对比 ----------------
// 只给出「该怎么打」指导性有限，还要说明各选项分别值多少筹码。
// 弃牌 EV 恒为 0（已投入的筹码是沉没成本，不计入）。
function buildEvTable(m) {
  const { equity, effectiveEquity, pot, toCall, canRaise, texture, draws, oppRange,
          hole, board } = m;
  const rows = [];

  // 弃牌：基准线
  rows.push({ action: 'fold', label: '弃牌', ev: 0, note: '放弃底池，不再投入' });

  // 全部采用「净收益」口径：只算本次决策之后的增量盈亏，
  // 已投入底池的筹码是沉没成本，不计入任何一行。这样各行才可直接比较。
  if (toCall > 0) {
    const callEV = equity * (pot + toCall) - toCall;
    rows.push({
      action: 'call', label: `跟注 ${toCall}`, ev: callEV,
      note: `${pct(equity)} × ${pot + toCall} − ${toCall}`
    });
  } else {
    // 过牌不投入筹码，净收益 = 胜率 × 现有底池（与跟注同口径）
    rows.push({
      action: 'check', label: '过牌', ev: equity * pot,
      note: `不投入筹码，${pct(equity)} × ${pot}`
    });
  }

  if (canRaise) {
    const betSize = Math.max(1, Math.round((pot + toCall) * (texture.wet > 0.55 ? 0.7 : 0.5)));
    const betRatio = (pot + toCall) > 0 ? betSize / (pot + toCall) : 0.5;
    const finalPot = pot + toCall + betSize * 2;

    // 对手跟注后，他弃掉的弱牌已从范围中剔除，剩下的子范围更强，
    // 所以被跟注时的胜率必然低于对抗全范围的胜率。
    //
    // 优先「真算」：派生会跟注的子范围，直接对它重跑加权模拟。
    // 只有在范围数据缺失或样本不足时才退回经验折减系数。
    // 翻前没有公共牌，无法按牌面强度剔除弱牌，真算会失真（甚至给出
    // 比全范围更高的胜率）。翻前一律走估算路径。
    let foldRate, eqCalled, method;
    const sub = (oppRange && hole && board && board.length >= 3)
      ? callingSubRange(oppRange, board, betRatio)
      : null;

    if (sub && sub.range.totalWeight > 0) {
      const eqReal = equityVsSubRange(hole, board, sub.range);
      if (eqReal !== null) {
        foldRate = sub.foldRate;
        // 对手跟注后范围只会变强，所以 eqCalled 必须 ≤ 全范围胜率 equity。
        // 上界用 equity 而不是 effectiveEquity：后者含听牌隐含补偿，
        // 拿它当上界会让「被跟注」的胜率反而高过「对抗全范围」，自相矛盾。
        // 隐含价值只按 eqReal 的比例追加，equity 为 0 时不凭空造出胜率。
        const impliedRatio = equity > 0.01 ? Math.max(0, effectiveEquity - equity) / equity : 0;
        const withImplied = eqReal * (1 + impliedRatio);
        eqCalled = Math.max(0, Math.min(equity, withImplied));
        method = 'real';
      }
    }

    if (method !== 'real') {
      foldRate = estimateFoldRate(oppRange, texture, betRatio);
      const shrink = 0.55 + 0.35 * (1 - foldRate);
      eqCalled = Math.max(0.02, Math.min(effectiveEquity, effectiveEquity * shrink));
      method = 'estimate';
    }

    // 对手弃牌我直接收下现有底池（我刚下的注退回）；跟注则按收紧后的胜率结算
    const evBet = foldRate * (pot + toCall)
      + (1 - foldRate) * (eqCalled * finalPot - (toCall + betSize));

    rows.push({
      action: toCall > 0 ? 'raise' : 'bet',
      label: `${toCall > 0 ? '加注' : '下注'} ${betSize}`,
      ev: evBet,
      method,
      note: `弃牌率 ${pct(foldRate)}${method === 'real' ? '' : '（估算）'}：`
        + `弃则收 ${pot + toCall}；被跟时对手范围收紧，`
        + `你的胜率${method === 'real' ? '实测' : '约'} ${pct(eqCalled)}`
    });
  }

  // 找出 EV 最高的动作
  let best = rows[0];
  for (const r of rows) if (r.ev > best.ev) best = r;
  for (const r of rows) r.isBest = (r === best);

  return { rows, bestAction: best.action, bestEV: best.ev };
}

// 估对手面对下注的弃牌率：按其范围里「空气 + 弱听牌」占比推算
// betRatio 是下注额相对当前底池的比例：注越大越能打走弱牌
function estimateFoldRate(range, texture, betRatio) {
  const ratio = betRatio > 0 ? betRatio : 0.5;
  // 尺度系数：半池为基准 1.0，满池约 1.25，1/4 池约 0.8
  const sizeFactor = Math.max(0.7, Math.min(1.35, 0.75 + ratio * 0.5));

  if (!range || !range.tierCount) {
    const base = texture.wet > 0.55 ? 0.35 : 0.45;
    return Math.max(0.05, Math.min(0.85, base * sizeFactor));
  }
  const t = range.tierCount;
  const sum = t.reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0.4;

  // 空气几乎全弃，弱听牌部分弃，弱对子少量弃，成牌基本不弃
  const weak = t[0] * 0.85 + t[1] * 0.45 + t[2] * 0.25;
  let rate = (weak / sum) * sizeFactor;
  // 潮湿牌面对手更有理由继续（听牌多），弃牌率打折
  if (texture.wet > 0.55) rate *= 0.8;
  return Math.max(0.05, Math.min(0.85, rate));
}

// 分析行动线路：对手是否连续过牌、上街是否只跟注、是否连续下注
function analyzeLine(snap, history) {
  const oppIds = snap.liveOpponentIds || [];
  const before = history.filter(h =>
    h.playerId !== 0 && oppIds.includes(h.playerId)
    && historyIndexOf(history, h) < historyIndexOf(history, snap));

  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const curIdx = STREETS.indexOf(snap.street);
  const prevStreet = curIdx > 0 ? STREETS[curIdx - 1] : null;

  const checksThisStreet = before.filter(h => h.street === snap.street && h.action === 'check');
  const checksPrevStreet = prevStreet
    ? before.filter(h => h.street === prevStreet && h.action === 'check') : [];
  const callsPrevStreet = prevStreet
    ? before.filter(h => h.street === prevStreet && h.action === 'call') : [];
  const betStreets = new Set(before
    .filter(h => ['bet', 'raise', 'allin'].includes(h.action))
    .map(h => h.street));

  return {
    // 对手在本街和上一街都过牌 ⇒ 范围弱
    oppCheckedTwice: checksThisStreet.length > 0 && checksPrevStreet.length > 0,
    oppCalledLastStreet: callsPrevStreet.length > 0,
    oppBetTwice: betStreets.size >= 2
  };
}

function historyIndexOf(history, entry) {
  return history.indexOf(entry);
}
// ---------------- 评级 ----------------
// EV 用标准公式：跟注 EV = equity*(pot+toCall) - toCall，单位是筹码
function gradeAction(actual, advice, m) {
  const { equity, effectiveEquity, needEquity, toCall, pot, callEV, draws, hand } = m;

  if (actual === advice) {
    return { tag: 'good', note: '与建议一致', evLoss: 0 };
  }
  // allin 本质是激进动作，与 bet/raise 建议方向一致时不算错
  if ((actual === 'allin') && (advice === 'bet' || advice === 'raise')) {
    return { tag: 'ok', note: '方向正确，但全下尺度过大，容易只被更强牌跟注', evLoss: 0 };
  }

  const lvl = a => (a === 'fold' ? 0 : (a === 'check' || a === 'call') ? 1 : 2);

  if (advice === 'fold' && actual === 'call') {
    const loss = Math.max(0, Math.round(-callEV));
    return {
      tag: loss > toCall * 0.15 ? 'leak' : 'ok',
      note: `这次跟注 ${toCall} 的期望值约 ${callEV.toFixed(1)} 筹码`
        + `（胜率 ${pct(equity)} 不足门槛 ${pct(needEquity)}），长期每次平均亏 ${loss}`,
      evLoss: loss
    };
  }

  if ((advice === 'call' || advice === 'raise' || advice === 'bet') && actual === 'fold') {
    const forgone = Math.max(0, Math.round(callEV));
    const note = draws.has
      ? `弃掉了 ${draws.label}（${draws.outs} outs），有效胜率约 ${pct(effectiveEquity)}，本可继续`
      : `胜率 ${pct(equity)} 已达门槛 ${pct(needEquity)}，弃牌放走约 ${forgone} 筹码期望收益`;
    return {
      tag: forgone > Math.max(2, pot * 0.04) ? 'leak' : 'ok',
      note, evLoss: forgone
    };
  }

  if (advice === 'raise' && actual === 'call') {
    const missed = Math.max(0, Math.round((equity - needEquity) * pot * 0.35));
    return {
      tag: 'ok',
      note: `牌力足够加注，只跟注少榨取了价值，粗估少赚约 ${missed} 筹码`,
      evLoss: 0
    };
  }
  if (advice === 'bet' && actual === 'check') {
    const missed = Math.max(0, Math.round((equity - 0.5) * pot * 0.5));
    return {
      tag: 'ok',
      note: `${hand.label} 领先时过牌，错过一次价值下注`
        + (missed > 0 ? `，粗估少赚约 ${missed} 筹码` : ''),
      evLoss: 0
    };
  }

  // 建议过牌但实际下注：这是文档里最常见的漏洞类型
  if (advice === 'check' && lvl(actual) === 2) {
    if (draws.has) {
      return {
        tag: 'ok',
        note: `持 ${draws.label} 下注属半诈唬，有 ${draws.outs} outs 兜底，可接受`,
        evLoss: 0
      };
    }
    // 有摊牌价值却下注，或纯空气在不合适的场合下注
    const isThin = hand.tier === 'medium' || hand.capped;
    return {
      tag: isThin || equity < 0.33 ? 'leak' : 'ok',
      note: isThin
        ? `${hand.label} 属中等牌力：下注既难让更弱牌跟注，也难让更强牌弃牌，`
          + '还要承担被加注后难以应对的风险。这是典型的「无效价值下注」'
        : `胜率仅 ${pct(equity)} 且无听牌仍下注，对手跟注时你基本落后`,
      evLoss: isThin ? Math.max(1, Math.round(pot * 0.08)) : 0
    };
  }

  if (advice === 'fold' && lvl(actual) === 2) {
    return {
      tag: 'ok',
      note: `牌力不足（胜率 ${pct(equity)}）仍进攻，属诈唬。低频可平衡范围，高频会被针对`,
      evLoss: 0
    };
  }

  // 建议下注/加注但实际弃牌（很少见，通常是极端情况）
  if (lvl(advice) === 2 && actual === 'check') {
    return { tag: 'ok', note: '建议更激进一些，过牌略保守', evLoss: 0 };
  }

  return { tag: 'ok', note: '与建议略有差异，影响有限', evLoss: 0 };
}

function actionLabel(snap) {
  const map = {
    fold: '弃牌', check: '过牌', call: `跟注 ${snap.toCall}`,
    bet: `下注到 ${snap.betAfter}`, raise: `加注到 ${snap.betAfter}`,
    allin: `全下 ${snap.betAfter}`
  };
  return map[snap.action] || snap.action;
}

function pct(v) {
  return (v * 100).toFixed(1) + '%';
}

// ---------------- 整手复盘 ----------------
function reviewHand(g) {
  const history = g.handHistory || [];
  const mine = history.filter(h => h.playerId === 0 && h.action);
  if (!mine.length) {
    return {
      points: [],
      summary: '本手你没有主动决策（例如尚未轮到你就结束），没有可复盘的内容。'
    };
  }

  const points = mine.map(snap => reviewDecision(snap, history));

  const leaks = points.filter(p => p.grade === 'leak');
  const oks = points.filter(p => p.grade === 'ok');
  const goods = points.filter(p => p.grade === 'good');
  const totalLoss = leaks.reduce((s, p) => s + (p.evLoss || 0), 0);

  const parts = [`本手 ${points.length} 个决策点`];
  if (goods.length) parts.push(`${goods.length} 个与建议一致`);
  if (oks.length) parts.push(`${oks.length} 个可优化（${uniqStreets(oks)}）`);
  if (leaks.length) {
    parts.push(`${leaks.length} 处明显漏洞（${uniqStreets(leaks)}）`
      + (totalLoss > 0 ? `，合计期望损失约 ${totalLoss} 筹码` : ''));
  }

  let summary = parts.join('，') + '。';
  if (!leaks.length && !oks.length) summary += '整体线路合理。';
  else if (!leaks.length) summary += '没有明显漏洞，细节上还能更激进一点。';

  // 汇总本手命中的战术原则，便于形成记忆点
  const principles = [...new Set(points.filter(p => p.principle).map(p => p.principle))];

  return {
    points, summary, principles,
    leakCount: leaks.length, okCount: oks.length, totalLoss
  };
}

function uniqStreets(list) {
  return [...new Set(list.map(p => p.streetLabel))].join('、');
}
