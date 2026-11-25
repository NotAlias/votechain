// Runs the core logic embedded in votechain.html under Node 20+.  Usage: node test/run-tests.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const html = readFileSync(fileURLToPath(new URL('../votechain.html', import.meta.url)), 'utf8');
const src = /<script id="core">([\s\S]*?)<\/script>/.exec(html)[1];
const VC = new Function(src + '\nreturn VC;')();

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.log('FAIL  ' + name + '\n      ' + (e.stack || e)); process.exitCode = 1; }
}
const lot = n => Array.from({ length: n }, (_, i) => String(i));
const B = (ranking, i) => ({ id: 'b' + i, ranking });
const rep = (n, ranking) => Array.from({ length: n }, () => ranking);
const add = async (an, ...blocks) => VC.analyse([...an.blocks, ...blocks]);
const body = b => { const { sig, ...rest } = b; return rest; };

// ---------- the count ----------
await test('STV: surplus transfers proportionally (6 A>B, 1 B, 2 C; elect 2)', () => {
  const r = VC.stv(3, 2, [...rep(6, [0, 1]), [1], ...rep(2, [2])].map(B), lot(3));
  assert.equal(String(r.quota), '4');
  assert.deepEqual(r.elected, [0, 1]);
  const o = r.outcome.get('b0');
  assert.equal(o.trail[0].w.toString(), '0.6666');
  assert.equal(o.trail[1].w.toString(), '0.3333');
});
await test('STV: electing one behaves as instant runoff', () => {
  const r = VC.stv(3, 1, [...rep(4, [0]), ...rep(3, [1]), ...rep(2, [2, 1])].map(B), lot(3));
  assert.equal(String(r.quota), '5');
  assert.deepEqual(r.elected, [1]);
});
await test('STV: a minority bloc wins its proportional share', () => {
  const r = VC.stv(5, 3, [...rep(60, [0, 1, 2]), ...rep(40, [3, 4])].map(B), lot(5));
  assert.deepEqual([...r.elected].sort(), [0, 1, 3]);
});
await test('STV: no ballots elects nobody; every ballot keeps a total value of 1', () => {
  assert.deepEqual(VC.stv(3, 2, [], lot(3)).elected, []);
  const r = VC.stv(4, 2, [...rep(7, [0, 1, 2]), ...rep(3, [1]), ...rep(4, [2, 0]), ...rep(2, [3])].map(B), lot(4));
  for (const [, o] of r.outcome) assert.equal(o.trail.reduce((s, t) => s.add(t.w), o.exhausted).toString(), '1');
});

// ---------- a full election ----------
const spec = {
  title: 'Test election', description: 'd', electorate: 6,
  races: [{ name: 'President', seats: 1, candidates: ['Ann', 'Bob', 'Cy'] }, { name: 'Committee', seats: 2, candidates: ['Di', 'Ed', 'Flo', 'Gus'] }],
  pools: [{ name: 'Verified', open: false, generate: 3 }, { name: 'Unverified', open: true }],
};
const el = await VC.createElection(spec);
const T = el.tickets.map(t => t.ticket);
const walk = [await VC.newVoterKey(), await VC.newVoterKey(), await VC.newVoterKey()];
const G = await VC.analyse([el.genesis]);
const cast = {};   // name -> {block, id, code, choices}
async function vote(name, an, ticket, choices) { cast[name] = { ...(await VC.createBallot(an, ticket, choices)), choices }; return cast[name].block; }
let open, final;

await test('genesis: positions, pools and the open pool are set up; tampering is caught', async () => {
  assert.deepEqual(G.errors, []);
  assert.equal(G.openPool, 1);
  assert.deepEqual(G.pools, [{ known: 3, voted: 0 }, { known: 0, voted: 0 }]);
  const bad = await VC.analyse([{ ...el.genesis, electorate: 99 }]);
  assert.equal(bad.genesis, null);
  await assert.rejects(VC.createElection({ ...spec, races: [{ name: 'P', seats: 2, candidates: ['A'] }] }), /number to elect/);
  await assert.rejects(VC.createElection({ ...spec, pools: [{ name: 'A', open: true }, { name: 'B', open: true }] }), /one pool can be open/);
});

await test('everyone votes in parallel from the genesis file; files merge in any order', async () => {
  // ticket holders and walk-ins all start from the same genesis file
  const blocks = [
    await vote('t0', G, T[0], [[0, 1], [0, 1]]),
    await vote('t1', G, T[1], [[0], [0, 2]]),
    await vote('t2', G, T[2], [[1, 0], [1]]),
    await vote('w0', G, walk[0].ticket, [[1], [3, 1]]),
    await vote('w1', G, walk[1].ticket, [[], [2]]),      // leaves President blank
  ];
  assert.ok(blocks.every(b => b.parents.length === 1 && b.parents[0] === el.id));
  open = await VC.analyse([blocks[3], blocks[0], el.genesis, blocks[4], blocks[1], blocks[2], blocks[0]]);
  assert.deepEqual(open.errors, []);
  assert.equal(open.blocks.length, 6);
  assert.equal(open.heads.length, 5);
  assert.deepEqual(open.pools, [{ known: 3, voted: 3 }, { known: 0, voted: 2 }]);
  assert.deepEqual((await VC.analyse([...open.blocks].reverse())).order, open.order);
  await assert.rejects(VC.createBallot(G, T[0], [[], []]), /at least one nominee/);
  await assert.rejects(VC.createBallot(G, T[0], [[0, 0], []]), /at most once/);
});

await test('ballots are unreadable without the organiser key', () => {
  const text = JSON.stringify(open.blocks);
  for (const c of Object.values(cast)) assert.equal(text.includes(c.code), false);
  assert.equal(new Set(open.blocks.filter(b => b.type === 'ballot').map(b => b.box.ct.length)).size, 1, 'all ciphertexts are the same length');
});

await test('admission moves a confirmed walk-in to the verified pool; a later admission overrides', async () => {
  const a1 = await VC.createAdmit(open, el.organiserKey, [{ voter: walk[0].pubString, pool: 0, note: 'Wanda' }]);
  const an = await add(open, a1.block);
  assert.deepEqual(an.errors, []);
  assert.deepEqual(an.pools, [{ known: 4, voted: 4 }, { known: 0, voted: 1 }]);
  assert.equal(an.admitted.get(walk[0].pub).note, 'Wanda');
  assert.deepEqual(an.heads, [a1.id]);
  // organiser corrects a mistake: the later block wins
  const a2 = await VC.createAdmit(an, el.organiserKey, [{ voter: walk[0].pubString, pool: 1, note: 'oops' }]);
  assert.equal((await add(an, a2.block)).poolOf(walk[0].pub), 1);
  // only the organiser can admit
  const forged = await VC.signBlock(body(a1.block), walk[1].pub, VC.parseTicket(walk[1].ticket).priv);
  const f = await VC.analyse([...open.blocks, forged]);
  assert.equal([...f.info.values()].find(n => n.type === 'admit').reason, 'invalid signature');
  await assert.rejects(VC.createAdmit(open, (await VC.createElection(spec)).organiserKey, [{ voter: walk[0].pubString, pool: 0 }]), /different election/);
  await assert.rejects(VC.createAdmit(open, el.organiserKey, [{ voter: 'nonsense', pool: 0 }]), /Not a voter public key/);
  open = an;
});

await test('without an open pool, an unknown key only counts once admitted', async () => {
  const e2 = await VC.createElection({ ...spec, pools: [{ name: 'Members', open: false, generate: 1 }] });
  const g2 = await VC.analyse([e2.genesis]);
  const v = await VC.createBallot(g2, walk[2].ticket, [[0], []]);
  let an = await add(g2, v.block);
  assert.equal(an.info.get(v.id).ineligible, true);
  assert.equal(an.voted.size, 0);
  an = await add(an, (await VC.createAdmit(an, e2.organiserKey, [{ voter: walk[2].pub, pool: 0, note: '' }])).block);
  assert.equal(an.voted.get(walk[2].pub), v.id);
});

await test('one ballot per key; forged, tampered and orphaned blocks are rejected', async () => {
  await assert.rejects(VC.createBallot(open, T[0], [[2], []]), /already voted/);
  const dup = await VC.createBallot(G, T[0], [[2], []]);
  const m = await add(open, dup.block);
  assert.equal([...m.info.values()].filter(n => n.superseded).length, 1);
  assert.equal(m.pools[0].voted, 4);
  const good = cast.t1.block;
  const badSig = await VC.analyse([el.genesis, { ...good, sig: good.sig.slice(0, -4) + 'AAAA' }]);
  assert.equal(badSig.info.get(cast.t1.id).reason, 'invalid signature');
  const t = await VC.analyse([el.genesis, { ...good, box: { ...good.box, ct: good.box.ct.slice(0, -4) + 'AAAA' } }]);
  assert.equal([...t.info.values()].filter(n => !n.valid).length, 1);
  const last = open.blocks[open.blocks.length - 1];
  const orphan = await VC.analyse([el.genesis, last]);
  assert.match(orphan.info.get(await VC.blockId(last)).reason, /missing parent/);
  assert.deepEqual((await VC.analyse([...orphan.blocks, ...open.blocks])).errors, []);
  assert.match((await VC.analyse([...open.blocks, (await VC.createElection(spec)).genesis])).errors[0], /more than one election/);
});

await test('organiser key file: passphrase protection round-trips', async () => {
  const p = await VC.protectKey(el.organiserKey, 'hunter2');
  assert.equal(JSON.stringify(p).includes(el.organiserKey.encPriv), false);
  assert.deepEqual(await VC.unprotectKey(p, 'hunter2'), el.organiserKey);
  await assert.rejects(VC.unprotectKey(p, 'wrong'), /Wrong passphrase/);
});

let tallyBlock;
await test('closing publishes anonymous ballots and a result anyone can recompute', async () => {
  // w2 copies t0's ciphertext into a ballot of their own: it cannot be opened under their key, so it is set aside
  const k = VC.parseTicket(walk[2].ticket);
  const copy = await VC.signBlock({ v: 1, type: 'ballot', election: el.id, parents: [el.id], voter: k.pub, box: cast.t0.block.box }, k.pub, k.priv);
  open = await add(open, copy);
  const other = await VC.createElection(spec);
  await assert.rejects(VC.createTally(open, other.organiserKey), /different election/);
  await assert.rejects(VC.createTally(open, { ...el.organiserKey, encPriv: other.organiserKey.encPriv }), /not the key/);
  const t = await VC.createTally(open, el.organiserKey);
  tallyBlock = t.block;
  final = await add(open, t.block);
  assert.deepEqual(final.errors, []);
  assert.equal(final.tally, t.id);
  // the closing block names no voter key, and carries no secret key
  const text = JSON.stringify(t.block);
  for (const v of final.voted.keys()) assert.equal(text.includes(v), false);
  assert.equal(text.includes(el.organiserKey.encPriv), false);
  assert.equal(text.includes(el.organiserKey.sigPriv), false);
  // counted: Verified = t0,t1,t2,w0 (4); Unverified = w1 (1) + the unreadable copy (set aside)
  assert.deepEqual(t.block.informal, [await VC.blockId(copy)]);
  assert.deepEqual(final.count.formal, [4, 1]);
  assert.deepEqual(t.block.revealed.map(p => p.map(l => l.length)), [[4, 4], [1, 1]]);
  assert.deepEqual(final.count.scopes.map(s => s.key), ['all', 'pool:0', 'pool:1']);
  // President, all pools: Ann 2 (t0,t1), Bob 2 (t2,w0), w1 blank -> 4 votes, quota 3, tie resolved deterministically
  const pres = final.count.scopes[0].races[0];
  assert.equal(pres.ballots, 4); assert.equal(pres.abstained, 1); assert.equal(String(pres.quota), '3');
  assert.equal(pres.elected.length, 1);
  // Committee, verified only: Di 2 (t0,t1), Ed 1 (t2), Gus 1 (w0); quota 2 -> Di, then one more
  const com = final.count.scopes[1].races[1];
  assert.equal(com.elected[0], 0); assert.equal(com.elected.length, 2);
  await assert.rejects(VC.createBallot(final, walk[2].ticket, [[0], []]), /closed/);
  await assert.rejects(VC.createTally(final, el.organiserKey), /closed/);
  await assert.rejects(VC.createAdmit(final, el.organiserKey, [{ voter: walk[1].pub, pool: 0 }]), /closed/);
});

const find = async (rev, code, ri) => { const c = await VC.codeFor(code, ri); for (const [pi, p] of rev.entries()) { const e = p[ri].find(x => x.c === c); if (e) return { pool: pi, r: e.r }; } return null; };
await test('a voter finds their own ballot with their receipt, per position, in the right pool', async () => {
  for (const [name, pool] of [['t0', 0], ['t2', 0], ['w0', 0], ['w1', 1]]) {
    for (const ri of [0, 1]) {
      const hit = await find(tallyBlock.revealed, cast[name].code, ri);
      assert.deepEqual(hit, { pool, r: cast[name].choices[ri] }, name + ' position ' + ri);
    }
  }
  // the codes for the two positions are unrelated, so a ballot cannot be reassembled across positions
  assert.notEqual(await VC.codeFor(cast.t0.code, 0), await VC.codeFor(cast.t0.code, 1));
  assert.equal(await find(tallyBlock.revealed, 'AAAAAAAAAAAAAAAAAAAAAA', 0), null);
  // the count traces each anonymous ballot
  assert.ok(final.count.scopes[0].races[1].outcome.has(await VC.codeFor(cast.t0.code, 1)));
});

const resign = b => VC.signBlock(b, el.genesis.orgPub, el.organiserKey.sigPriv);
const pre = () => final.blocks.filter(b => b.type !== 'tally');
await test('a dishonest closing block is caught: wrong result, dropped ballot, moved ballot', async () => {
  const b = body(tallyBlock);
  const lie = JSON.parse(JSON.stringify(b)); lie.results.scopes[0].races[0].elected = [2];
  assert.match((await VC.analyse([...pre(), await resign(lie)])).errors.join(' '), /does NOT match/);
  const dropped = JSON.parse(JSON.stringify(b)); dropped.revealed[0].forEach(l => l.pop());
  assert.match((await VC.analyse([...pre(), await resign(dropped)])).errors.join(' '), /does not match the number of ballots/);
  const moved = JSON.parse(JSON.stringify(b)); moved.revealed[1][0].push(moved.revealed[0][0].pop()); moved.revealed[1][1].push(moved.revealed[0][1].pop());
  moved.revealed.forEach(p => p.forEach(l => l.sort((x, y) => x.c < y.c ? -1 : 1)));
  assert.match((await VC.analyse([...pre(), await resign(moved)])).errors.join(' '), /does not match the number of ballots/);
  // someone other than the organiser cannot close
  const k = VC.parseTicket(T[0]);
  const fake = await VC.analyse([...pre(), await VC.signBlock(b, k.pub, k.priv)]);
  assert.equal(fake.tally, null);
});

await test('a silently altered ballot passes the public checks but its voter sees it with their receipt', async () => {
  // organiser rewrites t0's committee ranking and recomputes an internally consistent closing block
  const b = JSON.parse(JSON.stringify(body(tallyBlock)));
  const mine = await VC.codeFor(cast.t0.code, 1);
  b.revealed[0][1].find(e => e.c === mine).r = [3];
  const trial = await VC.analyse([...pre(), await resign(b)]);
  const fixed = { ...b, results: { scopes: trial.count.scopes.map(s => ({ key: s.key, races: s.races.map(r => ({ ballots: r.ballots, quota: String(r.quota), elected: r.elected })) })) } };
  const an = await VC.analyse([...pre(), await resign(fixed)]);
  assert.deepEqual(an.errors, []);
  const hit = await find(an.count.revealed, cast.t0.code, 1);
  assert.notDeepEqual(hit.r, cast.t0.choices[1]);
});

await test('an omitted ballot, a late ballot and a second closing block are all visible', async () => {
  // organiser closes without merging w1's file
  const without = await VC.analyse(pre().filter(b => b !== cast.w1.block));
  const early = await VC.createTally(without, el.organiserKey);
  const an = await VC.analyse([...without.blocks, early.block, cast.w1.block]);
  assert.equal(an.info.get(cast.w1.id).late, true);
  assert.equal(an.voted.has(walk[1].pub), false);
  const both = await VC.analyse([...final.blocks, early.block]);
  assert.equal(both.tallies.length, 2);
  assert.match(both.errors.join(' '), /different closing blocks/);
  const after = { v: 1, type: 'ballot', election: el.id, parents: [final.tally], voter: walk[1].pub, box: cast.w1.block.box };
  const k = VC.parseTicket(walk[1].ticket);
  const r = await add(final, await VC.signBlock(after, k.pub, k.priv));
  assert.equal([...r.info.values()].find(n => !n.valid).reason, 'added after the election was closed');
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
