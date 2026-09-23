// 翻后通用策略工具：MDF、牌面分类、下注尺度、SPR 分档
// 供 ai.js（对手决策）与 review.js（复盘建议）共用

// ---------------- MDF 最小防御频率 ----------------
// MDF = 底池 / (底池 + 下注) = 1 - 下注/(底池+下注)
// 含义：面对下注时至少要防守这么大比例的范围，否则对手可无风险诈唬。
// 低于 MDF 地弃牌 = 过度弃牌，会被对手用任意两张剥削。
function mdf(potSize, betSize) {
  if (betSize <= 0) return 1;
  return potSize / (potSize + betSize);
}

// 常用尺度速查（下注占底池比例 → MDF），供 UI 展示
const MDF_TABLE = [
  { ratio: 0.25, mdf: 0.80, label: '1/4 池' },
  { ratio: 0.33, mdf: 0.75, label: '1/3 池' },
  { ratio: 0.50, mdf: 0.67, label: '1/2 池' },
  { ratio: 0.66, mdf: 0.60, label: '2/3 池' },
  { ratio: 1.00, mdf: 0.50, label: '满池' },
  { ratio: 1.50, mdf: 0.40, label: '1.5 倍池' }
];

// 诈唬承接赔率：面对下注跟注需要的最低胜率 = 下注/(底池+2×下注)
// （与 MDF 是同一枚硬币两面：MDF 是范围级防守，这是单手承接）
function bluffCatchEquity(potSize, betSize) {
  if (betSize <= 0) return 0;
  return betSize / (potSize + 2 * betSize);
}

// ---------------- 牌面 5 分类 ----------------
// 干燥高牌面 / 湿润同花面 / 成对面 / 顺子面 / 彩虹安全面
// 每类给出标准持续下注频率与尺度，来源于两份策略文档的牌面策略表
const BOARD_STRATEGY = {
  dryHigh:   { label: '干燥高牌面', cbetFreq: 0.65, size: 0.5,  sizeLabel: '1/2 池', note: '高牌主导、无听牌，可高频小注持续下注' },
  wetFlush:  { label: '湿润同花面', cbetFreq: 0.45, size: 0.66, sizeLabel: '2/3 池', note: '听牌多，用极化范围下大注收保护费' },
  paired:    { label: '成对面',     cbetFreq: 0.55, size: 0.33, sizeLabel: '1/3 池', note: '易成暗三条，小注控池、降低被埋伏损失' },
  straighty: { label: '顺子面',     cbetFreq: 0.40, size: 0.5,  sizeLabel: '1/2 池', note: '顺子可能性高，谨慎下注、多过牌控制' },
  rainbow:   { label: '彩虹安全面', cbetFreq: 0.60, size: 0.5,  sizeLabel: '1/2 池', note: '无明显听牌，可宽范围下注剥削弱范围' }
};

// 把公共牌分到 5 类之一（翻牌起用，board 至少 3 张）
function classifyBoard(board) {
  if (!board || board.length < 3) return { key: 'rainbow', ...BOARD_STRATEGY.rainbow };

  const ranks = board.map(c => c.rank);
  const suits = board.map(c => c.suit);
  const suitCount = {};
  for (const s of suits) suitCount[s] = (suitCount[s] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCount));

  const uniqRanks = [...new Set(ranks)];
  const paired = uniqRanks.length < ranks.length;

  // 是否连张密集（3 张里任意两张间隔 ≤ 2，构成顺子威胁）
  const sorted = [...uniqRanks].sort((a, b) => a - b);
  let connected = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] <= 2) connected++;
  }
  const straighty = connected >= 2;

  const hasHigh = ranks.some(r => r >= 12);   // 有 Q/K/A

  // 优先级：成对 > 同花听牌面 > 顺子面 > 干燥高牌 > 彩虹
  let key;
  if (paired) key = 'paired';
  else if (maxSuit >= 2 && (maxSuit >= 3 || hasHigh)) key = maxSuit >= 3 ? 'wetFlush' : (straighty ? 'straighty' : 'dryHigh');
  else if (straighty) key = 'straighty';
  else if (hasHigh) key = 'dryHigh';
  else key = 'rainbow';

  return { key, ...BOARD_STRATEGY[key] };
}

// ---------------- SPR 筹码深度分档 ----------------
// SPR = 有效筹码 / 底池。决定该多尺度下注还是简化为推/弃。
// <1 短：只全下/弃牌；1-5 中短：单一尺度；5-10 中：标准；>10 深：多尺度、可慢玩
function sprBucket(effectiveStack, potSize) {
  const spr = potSize > 0 ? effectiveStack / potSize : 99;
  if (spr < 1)  return { spr, key: 'short',  label: '极短筹码', note: 'SPR<1：只考虑全下或弃牌，别做半吊子下注' };
  if (spr < 5)  return { spr, key: 'midlow', label: '中短筹码', note: 'SPR 1-5：单一尺度，成手直接投入，避免陷入两难' };
  if (spr < 10) return { spr, key: 'mid',    label: '中等筹码', note: 'SPR 5-10：标准打法，价值与诈唬平衡' };
  return { spr, key: 'deep', label: '深筹码', note: 'SPR>10：可多尺度、慢玩强牌、给听牌留操作空间' };
}

// ---------------- 河牌极化判断 ----------------
// 河牌该走极化：只用坚果价值下注 + 纯空气诈唬，中间牌一律过牌。
// 返回该手牌在河牌的角色：value / bluff / giveup（过牌）
function riverRole(handTier, hasBlocker) {
  // handTier 来自 review.js 的 classifyHand：nuts/strong/medium/weak/air
  if (handTier === 'nuts' || handTier === 'strong') return 'value';
  if (handTier === 'air') return hasBlocker ? 'bluff' : 'giveup';
  return 'giveup';   // 中间牌（medium/weak）一律过牌
}
