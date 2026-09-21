// 牌型评估自测：node _test_eval.js
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/js/cards.js', 'utf8');
global.window = {};
eval(src);

function P(str) { // "As Kh" -> cards
  const M = { A: 14, K: 13, Q: 12, J: 11, T: 10 };
  return str.trim().split(/\s+/).map(tok => {
    const suit = tok.slice(-1);
    const r = tok.slice(0, -1);
    return makeCard(M[r] || Number(r), suit);
  });
}

let pass = 0, fail = 0;
function eq(desc, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.log(`FAIL ${desc}\n  got=${got}\n  want=${want}`); }
}

// 分类判定
eq('皇家同花顺', evaluate7(P('As Ks Qs Js Ts 2h 3d')).category, 9);
eq('同花顺9高', evaluate7(P('9s 8s 7s 6s 5s Ah Kd')).category, 8);
eq('轮子同花顺', evaluate7(P('As 2s 3s 4s 5s Kh Qd')).category, 8);
eq('轮子同花顺高牌为5', evaluate7(P('As 2s 3s 4s 5s Kh Qd')).tiebreak[0], 5);
eq('四条', evaluate7(P('7s 7h 7d 7c Ks Qd 2h')).category, 7);
eq('葫芦', evaluate7(P('8s 8h 8d Kc Ks 2d 3h')).category, 6);
eq('同花', evaluate7(P('As Js 9s 6s 3s Kd Qh')).category, 5);
eq('顺子', evaluate7(P('9s 8h 7d 6c 5s As Kd')).category, 4);
eq('轮子顺子', evaluate7(P('As 2h 3d 4c 5s Kh Qd')).category, 4);
eq('轮子顺子高牌为5', evaluate7(P('As 2h 3d 4c 5s Kh Qd')).tiebreak[0], 5);
eq('三条', evaluate7(P('5s 5h 5d Kc 9s 2d 3h')).category, 3);
eq('两对', evaluate7(P('5s 5h 9d 9c Ks 2d 3h')).category, 2);
eq('一对', evaluate7(P('5s 5h 9d Kc Qs 2d 3h')).category, 1);
eq('高牌', evaluate7(P('2s 5h 9d Kc Qs 7d 3h')).category, 0);
// 七张里不能凑成顺子的错误组合
eq('非顺子(跨越)', evaluate7(P('2s 3h 4d 5c 7s 9d Jh')).category, 0);

// 比牌
const cmp = (a, b) => compareHands(evaluate7(P(a)), evaluate7(P(b)));
eq('四条A>四条K', cmp('As Ah Ad Ac 2s 3d 4h', 'Ks Kh Kd Kc As 3d 4h') > 0, true);
eq('葫芦比三条部分', cmp('8s 8h 8d 2c 2s 5d 7h', '7s 7h 7d Ac As 5d 9h') > 0, true);
eq('同一葫芦比对子部分', cmp('8s 8h 8d Kc Ks 2d 3h', '8s 8h 8d Qc Qs 2d 3h') > 0, true);
eq('同花踢脚', cmp('As Qs 9s 6s 3s Kd 2h', 'As Js 9s 6s 3s Kd 2h') > 0, true);
eq('一对同点比踢脚', cmp('9s 9h As Kd 5c 2h 3d', '9s 9h As Qd 5c 2h 3d') > 0, true);
eq('平局', cmp('9s 9h As Kd 5c 2h 3d', '9d 9c As Kh 5s 2h 3d'), 0);
eq('顺子>三条', cmp('9s 8h 7d 6c 5s 2d 3h', 'As Ah Ad 5c 9s 2d 4h') > 0, true);
eq('同花>顺子', cmp('As Js 9s 6s 3s Kd Qh', '9s 8h 7d 6c 5s 2d 3h') > 0, true);
eq('两对比大对', cmp('Ks Kh 2d 2c 9s 5d 7h', 'Qs Qh Jd Jc 9s 5d 7h') > 0, true);

// describeHand 不报错
eq('describe葫芦', describeHand(evaluate7(P('8s 8h 8d Kc Ks 2d 3h'))), '葫芦 8 带 K');

console.log(`\npass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
