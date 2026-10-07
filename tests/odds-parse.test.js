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

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('all passed');
