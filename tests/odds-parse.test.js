// Price-parsing checks for Football.americanOddsIn.
// Run from the repo root: node tests/odds-parse.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const context = vm.createContext({});
const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'football.js'), 'utf8');
vm.runInContext(`${src}\nglobalThis.Football = Football;\n`, context);
const scan = context.Football.americanOddsIn;

let failed = 0;
function show(hits) {
  if (!hits.length) return '(none)';
  return hits.map((h) => `${h.odds} @ ${h.path}${h.side ? ` (${h.side})` : ''}`).join(', ');
}
function check(label, input, expectOdds) {
  const hits = scan(input);
  const got = hits.map((h) => h.odds);
  const ok = hits.length === expectOdds.length
    && JSON.stringify([...got].sort((a, b) => a - b)) === JSON.stringify([...expectOdds].sort((a, b) => a - b));
  if (!ok) failed += 1;
  const n = hits.length;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} => ${n} hit${n === 1 ? '' : 's'}: ${show(hits)}`);
  return hits;
}
function assert(label, ok) {
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}

const sidedPair = check('{odds:{overOdds:-115, underOdds:-105}}', { odds: { overOdds: -115, underOdds: -105 } }, [-115, -105]);
const different = check('{odds:{value:-110, american:-120}}', { odds: { value: -110, american: -120 } }, [-110, -120]);
check('{odds:{value:-110, american:-110}}', { odds: { value: -110, american: -110 } }, [-110]);
check('{odds:{american:"-120"}}', { odds: { american: '-120' } }, [-120]);
check('{american:"-120"}', { american: '-120' }, [-120]);
check('{over:{american:-115}, under:{american:-105}}', { over: { american: -115 }, under: { american: -105 } }, [-115, -105]);
check('{oddsId:123456}', { oddsId: 123456 }, []);
check('{priceID:123456}', { priceID: 123456 }, []);
check('{american:"EVEN"}', { american: 'EVEN' }, [100]);
check('{american:10001}', { american: 10001 }, []);
check('{american:-10001}', { american: -10001 }, []);
assert('sides: -115 over and -105 under', sidedPair.length === 2
  && sidedPair.some((h) => h.odds === -115 && h.side === 'over')
  && sidedPair.some((h) => h.odds === -105 && h.side === 'under'));
assert('-120 is present', different.some((h) => h.odds === -120));

const nested = check('{odds:{over:-115, under:-105, american:-115}}', { odds: { over: -115, under: -105, american: -115 } }, [-115, -105]);
const minus115 = nested.filter((h) => h.odds === -115);
assert('-115 once, with side over; -105 under', nested.length === 2
  && minus115.length === 1
  && minus115[0].side === 'over'
  && nested.some((h) => h.odds === -105 && h.side === 'under'));
check('{odds:{over:"-115", under:"-105", american:"-115"}}', { odds: { over: '-115', under: '-105', american: '-115' } }, [-115, -105]);

check('{odds:{over:245.5, under:245.5}}', { odds: { over: 245.5, under: 245.5 } }, []);
check('{odds:{over:"265.5"}}', { odds: { over: '265.5' } }, []);
check('{odds:{overOdds:245.5}}', { odds: { overOdds: 245.5 } }, []);
check('{over:{odds:{line:250, yards:275, id:300}}}', { over: { odds: { line: 250, yards: 275, id: 300 } } }, []);
check('{odds:{overUnder:-110}}', { odds: { overUnder: -110 } }, []);
const sameUnder = check('{odds:{under:-105, underOdds:-105}}', { odds: { under: -105, underOdds: -105 } }, [-105]);
assert('under -105 once', sameUnder.length === 1 && sameUnder[0].side === 'under' && sameUnder[0].odds === -105);
check('{a:{odds:{over:-110}}, b:{odds:{american:-110}}}', { a: { odds: { over: -110 } }, b: { odds: { american: -110 } } }, [-110, -110]);
check('{b:{odds:{american:-110}}, a:{odds:{over:-110}}}', { b: { odds: { american: -110 } }, a: { odds: { over: -110 } } }, [-110, -110]);
const evenOver = check('{odds:{over:"EVEN"}}', { odds: { over: 'EVEN' } }, [100]);
assert('+100 over', evenOver.length === 1 && evenOver[0].odds === 100 && evenOver[0].side === 'over');
check('{odds:{over:"EV"}}', { odds: { over: 'EV' } }, [100]);

// Vig check for bare over/under pairs: yard-line pairs fail, real vig passes.
check('{odds:{over:250, under:250}}', { odds: { over: 250, under: 250 } }, []);
check('{odds:{over:250, under:260}}', { odds: { over: 250, under: 260 } }, []);
check('{odds:{over:"245", under:"245"}}', { odds: { over: '245', under: '245' } }, []);
check('{odds:{over:-115, under:-105}}', { odds: { over: -115, under: -105 } }, [-115, -105]);
check('{odds:{over:"EVEN", under:"EVEN"}}', { odds: { over: 'EVEN', under: 'EVEN' } }, [100, 100]);
check('{odds:{over:-150, under:110}}', { odds: { over: -150, under: 110 } }, [-150, 110]);
check('{odds:{over:-300, under:250}}', { odds: { over: -300, under: 250 } }, [-300, 250]);
check('{odds:{over:-200, under:-200}}', { odds: { over: -200, under: -200 } }, []);
const loneNeg = check('{odds:{over:-110}}', { odds: { over: -110 } }, [-110]);
assert('lone over -110 kept with side over', loneNeg.length === 1 && loneNeg[0].side === 'over');
check('{odds:{over:250}}', { odds: { over: 250 } }, []);
const loneEven = check('{odds:{over:"EVEN"}} lone', { odds: { over: 'EVEN' } }, [100]);
assert('lone EVEN kept with side over', loneEven.length === 1 && loneEven[0].side === 'over');
const marketName = check('{odds:{overUnderOdds:-110}}', { odds: { overUnderOdds: -110 } }, [-110]);
assert('overUnderOdds is unsided', marketName.length === 1 && marketName[0].side == null);
const sidedPrice = check('{odds:{overOdds:150}}', { odds: { overOdds: 150 } }, [150]);
assert('overOdds +150 kept with side over', sidedPrice.length === 1 && sidedPrice[0].side === 'over');
const overtime = check('{odds:{overtimeOdds:-110}}', { odds: { overtimeOdds: -110 } }, [-110]);
assert('overtimeOdds is unsided', overtime.length === 1 && overtime[0].side == null);
const overall = check('{odds:{overallOdds:-110}}', { odds: { overallOdds: -110 } }, [-110]);
assert('overallOdds is unsided', overall.length === 1 && overall[0].side == null);
const underdog = check('{odds:{underdogOdds:150}}', { odds: { underdogOdds: 150 } }, [150]);
assert('underdogOdds is unsided', underdog.length === 1 && underdog[0].side == null);
const overStill = check('{odds:{overOdds:150}} still over', { odds: { overOdds: 150 } }, [150]);
assert('overOdds still over', overStill.length === 1 && overStill[0].side === 'over');
const underStill = check('{odds:{underOdds:-110}}', { odds: { underOdds: -110 } }, [-110]);
assert('underOdds still under', underStill.length === 1 && underStill[0].side === 'under');
check('{odds:{over:-400, under:150}} sums to exactly 1.20', { odds: { over: -400, under: 150 } }, [-400, 150]);
const lonePlus100 = check('{odds:{over:"+100"}} lone', { odds: { over: '+100' } }, [100]);
assert('lone "+100" kept with side over', lonePlus100.length === 1 && lonePlus100[0].side === 'over');
check('{odds:{over:100}} lone', { odds: { over: 100 } }, []);
check('{odds:{over:"100"}} lone', { odds: { over: '100' } }, []);
check('{odds:{over:100, under:100}}', { odds: { over: 100, under: 100 } }, []);
check('{odds:{over:101, under:101}}', { odds: { over: 101, under: 101 } }, []);
check('{odds:{over:"+100", under:"+100"}}', { odds: { over: '+100', under: '+100' } }, [100, 100]);
check('{odds:{over:"EVEN", under:"EVEN"}} pair', { odds: { over: 'EVEN', under: 'EVEN' } }, [100, 100]);
check('{odds:{over:-120, under:100}} mixed', { odds: { over: -120, under: 100 } }, [-120, 100]);
const fair = context.Football.impliedFromMoneylines(-115, -105);
assert('de-vig -115/-105 is 51.1/48.9',
  fair && Math.abs(fair.home - 51.1) < 0.05 && Math.abs(fair.away - 48.9) < 0.05);

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
