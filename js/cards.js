// 牌、牌堆、牌型评估

const SUITS = ['s', 'h', 'd', 'c'];          // 黑桃 红心 方块 梅花
const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_NAME = { s: '黑桃', h: '红心', d: '方块', c: '梅花' };
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const RANK_LABEL = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  10: '10', 11: 'J', 12: 'Q', 13: 'K', 14: 'A'
};

const HAND_NAMES = [
  '高牌', '一对', '两对', '三条', '顺子',
  '同花', '葫芦', '四条', '同花顺', '皇家同花顺'
];

function makeCard(rank, suit) {
  return { rank, suit, label: RANK_LABEL[rank], symbol: SUIT_SYMBOL[suit] };
}

function cardToString(card) {
  return RANK_LABEL[card.rank] + SUIT_SYMBOL[card.suit];
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push(makeCard(rank, suit));
  }
  return deck;
}

// Fisher-Yates，使用 crypto 取随机源
function shuffle(deck) {
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------- 牌型评估 ----------------
// 返回 { category: 0-9, tiebreak: [..], name, cards }
// 比较规则：先比 category，再按 tiebreak 数组逐位比大小
function evaluate7(cards) {
  let best = null;
  const n = cards.length;
  // 7 选 5 共 21 种组合，直接穷举最稳
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate5(combo);
            if (!best || compareHands(score, best) > 0) best = score;
          }
  return best;
}

function evaluate5(combo) {
  const ranks = combo.map(c => c.rank).sort((x, y) => y - x);
  const suits = combo.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // 统计点数出现次数
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // 先按出现次数降序，同次数按点数降序
  const groups = Object.keys(counts)
    .map(Number)
    .sort((x, y) => counts[y] - counts[x] || y - x);
  const shape = groups.map(r => counts[r]);

  const straightHigh = getStraightHigh(ranks);

  let category, tiebreak;
  if (isFlush && straightHigh) {
    category = straightHigh === 14 ? 9 : 8;
    tiebreak = [straightHigh];
  } else if (shape[0] === 4) {
    category = 7;
    tiebreak = groups;                    // [四条点数, 单张]
  } else if (shape[0] === 3 && shape[1] === 2) {
    category = 6;
    tiebreak = groups;                    // [三条点数, 对子点数]
  } else if (isFlush) {
    category = 5;
    tiebreak = ranks;
  } else if (straightHigh) {
    category = 4;
    tiebreak = [straightHigh];
  } else if (shape[0] === 3) {
    category = 3;
    tiebreak = groups;
  } else if (shape[0] === 2 && shape[1] === 2) {
    category = 2;
    tiebreak = groups;                    // [大对, 小对, 单张]
  } else if (shape[0] === 2) {
    category = 1;
    tiebreak = groups;
  } else {
    category = 0;
    tiebreak = ranks;
  }

  return { category, tiebreak, name: HAND_NAMES[category], cards: combo };
}

// 返回顺子最大点数，无顺子返回 0。A-2-3-4-5 按 5 计算
function getStraightHigh(sortedDesc) {
  const uniq = [...new Set(sortedDesc)];
  if (uniq.length < 5) return 0;
  for (let i = 0; i <= uniq.length - 5; i++) {
    if (uniq[i] - uniq[i + 4] === 4) return uniq[i];
  }
  // 轮子 A-5：A 当 1 用
  if (uniq[0] === 14 && [5, 4, 3, 2].every(r => uniq.includes(r))) return 5;
  return 0;
}

function compareHands(h1, h2) {
  if (h1.category !== h2.category) return h1.category - h2.category;
  const len = Math.max(h1.tiebreak.length, h2.tiebreak.length);
  for (let i = 0; i < len; i++) {
    const a = h1.tiebreak[i] || 0;
    const b = h2.tiebreak[i] || 0;
    if (a !== b) return a - b;
  }
  return 0;
}

// 生成可读描述，如「葫芦 K带9」
function describeHand(h) {
  const L = r => RANK_LABEL[r];
  const t = h.tiebreak;
  switch (h.category) {
    case 9: return '皇家同花顺';
    case 8: return `同花顺 ${L(t[0])} 高`;
    case 7: return `四条 ${L(t[0])}`;
    case 6: return `葫芦 ${L(t[0])} 带 ${L(t[1])}`;
    case 5: return `同花 ${L(t[0])} 高`;
    case 4: return `顺子 ${L(t[0])} 高`;
    case 3: return `三条 ${L(t[0])}`;
    case 2: return `两对 ${L(t[0])} 和 ${L(t[1])}，${L(t[2])} 踢脚`;
    case 1: return `一对 ${L(t[0])}，${L(t[1])} 踢脚`;
    default: return `高牌 ${L(t[0])}，次张 ${L(t[1])}`;
  }
}

function randomInt(max) {
  if (window.crypto && window.crypto.getRandomValues) {
    const range = 4294967296;
    const limit = range - (range % max);
    const buf = new Uint32Array(1);
    let v;
    do {
      window.crypto.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % max;
  }
  return Math.floor(Math.random() * max);
}
