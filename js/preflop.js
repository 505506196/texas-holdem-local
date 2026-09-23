// 翻前范围管理：位置标准化 + 169 手强度序列 + 组合数权重

// 手牌标准化记号：AA/AKs/AKo/72o
function handNotation(hole) {
  const [a, b] = hole[0].rank >= hole[1].rank ? [hole[0], hole[1]] : [hole[1], hole[0]];
  const ranks = '23456789TJQKA';
  const hi = ranks[a.rank - 2];
  const lo = ranks[b.rank - 2];
  if (a.rank === b.rank) return hi + hi;
  const suited = a.suit === b.suit ? 's' : 'o';
  return hi + lo + suited;
}

// 169 手起手牌强度排序（高到低，无重复，覆盖全部 169 手）
// 来源：GTO Wizard 与两份策略文档调和后的通用强度序
const HAND_STRENGTH_ORDER = [
  // 顶级：大对子 + 顶级同花/不同花高张
  'AA','KK','QQ','JJ','AKs','AKo','TT','AQs','AQo','KQs',
  '99','AJs','KJs','ATs','KQo','QJs',
  // 强牌：中对 + 宽同花高张 + 强不同花
  '88','KTs','QTs','JTs','AJo','KJo','A9s','QJo',
  '77','A8s','A5s','T9s','A7s','A4s','A3s','A2s','A6s','ATo','KTo','QTo','JTo',
  // 中等：小对 + 同花连张 + 同花K/Q高张
  '66','98s','K9s','A9o','T8s','Q9s','J9s','87s','55','76s','65s','54s',
  '44','33','22','K8s','K7s','K6s','K5s','K4s','K3s','K2s',
  '97s','86s','75s','64s','53s','43s',
  // 边际：宽A不同花 + 同花Q/J/T高张 + 不同花连张
  'A8o','A7o','A6o','A5o','A4o','A3o','A2o',
  'K9o','Q9o','J9o','T9o','98o','T8o','87o','76o','65o','54o',
  'Q8s','Q7s','Q6s','Q5s','Q4s','Q3s','Q2s',
  'J8s','J7s','J6s','J5s','J4s','J3s','J2s',
  'T7s','T6s','T5s','T4s','T3s','T2s',
  '96s','95s','94s','93s','92s','85s','84s','83s','82s',
  '74s','73s','72s','63s','62s','52s','42s','32s',
  // 垃圾：其余不同花
  'K8o','K7o','K6o','K5o','K4o','K3o','K2o',
  'Q8o','Q7o','Q6o','Q5o','Q4o','Q3o','Q2o',
  'J8o','J7o','J6o','J5o','J4o','J3o','J2o',
  'T7o','T6o','T5o','T4o','T3o','T2o',
  '97o','96o','95o','94o','93o','92o',
  '86o','85o','84o','83o','82o',
  '75o','74o','73o','72o','64o','63o','62o',
  '53o','52o','43o','42o','32o'
];

// 组合数：对子6种、同花4种、不同花12种
function combosOf(notation) {
  if (notation.length === 2) return 6;    // AA
  if (notation[2] === 's') return 4;      // AKs
  return 12;                              // AKo
}

// 按组合数累加，取前 N% 范围（返回记号集合）
function topPercentRange(percent) {
  const totalCombos = 1326;  // 52选2
  const target = Math.round(totalCombos * percent / 100);
  const range = new Set();
  let acc = 0;
  for (const h of HAND_STRENGTH_ORDER) {
    range.add(h);
    acc += combosOf(h);
    if (acc >= target) break;
  }
  return range;
}

// 位置标准范围表（6-max，调和文档中的 CO/BTN 冲突，取标准值）
// 开池率参考：判断.txt 给 CO=40-45%/BTN=50-55%，职业级AI.txt 给 CO<30%/BTN<45%
// 此处取 GTO Wizard 主流值：UTG 15 / MP 19 / CO 27 / BTN 43 / SB 36 / BB防守 38
const POSITION_RANGES = {
  UTG:  { open: 15, threeBet: 5, call: 12 },
  MP:   { open: 19, threeBet: 8, call: 16 },
  CO:   { open: 27, threeBet: 12, call: 22 },
  BTN:  { open: 43, threeBet: 18, call: 38 },
  SB:   { open: 36, threeBet: 14, call: 32 },
  BB:   { open: 0, threeBet: 10, call: 38 }   // BB 不开池，只防守
};

// 座位转换：人数 + 到按钮的偏移 → 位置代号
// 关键：game.js 的 postBlinds 里 sbIndex = 按钮后一位、bbIndex = 再后一位，
// 所以 offset 1 必是 SB、offset 2 必是 BB，其余从按钮往前倒推排位置强度。
function seatToPosition(seatIdx, btnIdx, totalSeats) {
  const offset = (seatIdx - btnIdx + totalSeats) % totalSeats;

  // 单挑：按钮位下小盲
  if (totalSeats === 2) return offset === 0 ? 'BTN' : 'BB';

  // 3 人及以上：offset 1 = SB，offset 2 = BB，offset 0 = BTN
  if (offset === 0) return 'BTN';
  if (offset === 1) return 'SB';
  if (offset === 2) return 'BB';

  // 从 BB 之后到 BTN 之前，是行动顺序上的早位到后位：
  // 最后一个（紧邻 BTN）= CO，倒数第二 = MP/HJ，更靠前 = UTG
  const seatsAfterBB = totalSeats - 3;          // BB 与 BTN 之间的座位数
  const idxAfterBB = offset - 3;                // 0 = 第一个行动位（最早）
  const fromButton = seatsAfterBB - 1 - idxAfterBB;  // 0 = 紧邻按钮（最后行动）
  if (fromButton === 0) return 'CO';
  if (fromButton === 1) return 'MP';
  return 'UTG';                                 // 更早的位置统一算 UTG
}

// 检查手牌是否在该位置/动作的范围内
function isInRange(hole, position, action) {
  const notation = handNotation(hole);
  const ranges = POSITION_RANGES[position];
  if (!ranges || !ranges[action]) return false;
  const range = topPercentRange(ranges[action]);
  return range.has(notation);
}

// 性格调制：松手扩大范围，紧手收缩，同时保留部分随机诈唬
function adjustRangeForPersona(basePercent, personaKey, action) {
  const mods = {
    tight:    { open: -4, call: -3, threeBet: -2 },
    balanced: { open: 0, call: 0, threeBet: 0 },
    loose:    { open: +8, call: +6, threeBet: +4 },
    station:  { open: -2, call: +10, threeBet: -3 }
  };
  const mod = (mods[personaKey] || mods.balanced)[action] || 0;
  return Math.max(5, Math.min(55, basePercent + mod));
}
