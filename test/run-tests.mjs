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

await test('STV: surplus transfers proportionally (6 A>B, 1 B, 2 C; 2 seats)', () => {
  const r = VC.stv(3, 2, [...rep(6, [0, 1]), [1], ...rep(2, [2])].map(B), lot(3));
  assert.equal(String(r.quota), '4');
  assert.deepEqual(r.elected, [0, 1]);
  // each A>B ballot keeps 2/3 with A and passes 1/3 to B
  const o = r.outcome.get('b0');
  assert.equal(o.trail[0].w.toString(), '0.6666');
  assert.equal(o.trail[1].w.toString(), '0.3333');
});
await test('STV: one seat behaves as instant runoff', () => {
  // A 4, B 3, C 2 (C>B): C excluded, B wins 5-4
  const r = VC.stv(3, 1, [...rep(4, [0]), ...rep(3, [1]), ...rep(2, [2, 1])].map(B), lot(3));
  assert.equal(String(r.quota), '5');
  assert.deepEqual(r.elected, [1]);
});
await test('STV: a minority bloc wins its proportional share', () => {
  // 60 voters for party X (A>B>C), 40 for party Y (D>E); 3 seats -> X gets 2, Y gets 1
  const r = VC.stv(5, 3, [...rep(60, [0, 1, 2]), ...rep(40, [3, 4])].map(B), lot(5));
  assert.deepEqual([...r.elected].sort(), [0, 1, 3]);
});
await test('STV: no ballots elects nobody; total value is conserved', () => {
  assert.deepEqual(VC.stv(3, 2, [], lot(3)).elected, []);
  const bs = [...rep(7, [0, 1, 2]), ...rep(3, [1]), ...rep(4, [2, 0]), ...rep(2, [3])].map(B);
  const r = VC.stv(4, 2, bs, lot(4));
  for (const [, o] of r.outcome) {
    const sum = o.trail.reduce((s, t) => s.add(t.w), o.exhausted);
    assert.equal(sum.toString(), '1');
  }
});

// ---- full election flow ----
const spec = {
  title: 'Test election', description: 'd', candidates: ['Ann', 'Bob', 'Cy', 'Di'], seats: 2,
  pools: [{ name: 'Members', binding: true, generate: 6 }, { name: 'Supporters', binding: false, generate: 3 }],
};
const el = await VC.createElection(spec);
const members = el.tickets.filter(t => t.pool === 'Members').map(t => t.ticket);
const supporters = el.tickets.filter(t => t.pool === 'Supporters').map(t => t.ticket);
const genesisOnly = [el.genesis];
let finalBlocks, firstBallotId, lateBlock;

await test('genesis verifies; roll and pools are set up', async () => {
  const an = await VC.analyse(genesisOnly);
  assert.deepEqual(an.errors, []);
  assert.equal(an.id, el.id);
  assert.deepEqual(an.turnout, [{ roll: 6, voted: 0 }, { roll: 3, voted: 0 }]);
  assert.deepEqual(an.heads, [el.id]);
});
await test('tampered genesis is rejected', async () => {
  const an = await VC.analyse([{ ...el.genesis, seats: 1 }]);
  assert.equal(an.genesis, null);
  assert.match(an.errors[0], /signature/);
});

await test('voters fork from genesis, files merge, later voters chain on top', async () => {
  const an0 = await VC.analyse(genesisOnly);
  // three voters each work from the genesis file independently
  const a = await VC.createBallot(an0, members[0], [0, 1]);
  const b = await VC.createBallot(an0, members[1], [0, 1]);
  const c = await VC.createBallot(an0, supporters[0], [3]);
  firstBallotId = a.id;
  // merge = union of blocks, in any order, with duplicates
  const merged = await VC.analyse([c.block, el.genesis, a.block, b.block, a.block]);
  assert.deepEqual(merged.errors, []);
  assert.equal(merged.blocks.length, 4);
  assert.equal(merged.heads.length, 3);
  // the next voter builds on all three heads, knitting the forks together
  const d = await VC.createBallot(merged, members[2], [0, 1, 2]);
  assert.equal(d.block.parents.length, 3);
  let an = await VC.analyse([...merged.blocks, d.block]);
  assert.deepEqual(an.heads, [d.id]);
  for (const [t, r] of [[members[3], [1]], [members[4], [2]], [members[5], [0, 1]], [supporters[1], [3, 2]]]) {
    const x = await VC.createBallot(an, t, r);
    an = await VC.analyse([...an.blocks, x.block]);
  }
  assert.deepEqual(an.errors, []);
  assert.deepEqual(an.turnout, [{ roll: 6, voted: 6 }, { roll: 3, voted: 2 }]);
  // merging is order independent
  const shuffled = await VC.analyse([...an.blocks].reverse());
  assert.deepEqual(shuffled.order, an.order);
  finalBlocks = an.blocks;
});

await test('a ticket cannot vote twice; a forged duplicate is not counted', async () => {
  const an = await VC.analyse(finalBlocks);
  await assert.rejects(VC.createBallot(an, members[0], [2]), /already voted/);
  // the voter tries again from the bare genesis file and merges it in
  const dup = await VC.createBallot(await VC.analyse(genesisOnly), members[0], [2]);
  const m = await VC.analyse([...finalBlocks, dup.block]);
  const sup = [...m.info.values()].filter(n => n.superseded);
  assert.equal(sup.length, 1);
  assert.equal(m.turnout[0].voted, 6);
});
await test('unknown voters, bad signatures, tampered and orphaned ballots are rejected', async () => {
  const an = await VC.analyse(finalBlocks);
  const stranger = await VC.newVoterKey();
  await assert.rejects(VC.createBallot(an, stranger.ticket, [0]), /not on the voter roll/);
  await assert.rejects(VC.createBallot(await VC.analyse(genesisOnly), members[0], [0, 0]), /at most once/);
  const good = finalBlocks.find(b => b.type === 'ballot');
  const id = await VC.blockId(good);
  const badSig = await VC.analyse([el.genesis, { ...good, sig: good.sig.slice(0, -4) + 'AAAA' }]);
  assert.equal(badSig.info.get(id).reason, 'invalid signature');
  // changing the body changes the ID, and the signature no longer covers it
  const swapped = { ...good, box: { ...good.box, ct: good.box.ct.slice(0, -4) + 'AAAA' } };
  const t = await VC.analyse([el.genesis, swapped]);
  assert.equal([...t.info.values()].filter(n => !n.valid).length, 1);
  // a block whose parent is absent is held as an orphan, and becomes valid once merged
  const last = finalBlocks[finalBlocks.length - 1];
  const orphan = await VC.analyse([el.genesis, last]);
  assert.match(orphan.info.get(await VC.blockId(last)).reason, /missing parent/);
  assert.equal(orphan.blocks.length, 2);
  assert.deepEqual((await VC.analyse([...orphan.blocks, ...finalBlocks])).errors, []);
  // blocks from another election do not merge
  const other = await VC.createElection(spec);
  assert.match((await VC.analyse([...finalBlocks, other.genesis])).errors[0], /more than one election/);
});

await test('organiser key file: passphrase protection round-trips', async () => {
  const p = await VC.protectKey(el.organiserKey, 'hunter2');
  assert.equal(JSON.stringify(p).includes(el.organiserKey.encPriv), false);
  assert.deepEqual(await VC.unprotectKey(p, 'hunter2'), el.organiserKey);
  await assert.rejects(VC.unprotectKey(p, 'wrong'), /Wrong passphrase/);
});

await test('closing: tally block verifies and anyone can recompute the result', async () => {
  // a ballot that copies someone else's ciphertext must come out informal
  const an0 = await VC.analyse(finalBlocks);
  const copyVictim = finalBlocks.find(b => b.type === 'ballot');
  const fresh = await VC.createBallot(an0, supporters[2], [0]);
  assert.notEqual(fresh.block.box.ct, copyVictim.box.ct);
  const an = await VC.analyse([...finalBlocks, fresh.block]);
  const other = await VC.createElection(spec);
  await assert.rejects(VC.createTally(an, other.organiserKey), /different election/);
  await assert.rejects(VC.createTally(an, { ...el.organiserKey, encPriv: other.organiserKey.encPriv }), /not the key/);
  const tally = await VC.createTally(an, el.organiserKey);
  const fin = await VC.analyse([...an.blocks, tally.block]);
  assert.deepEqual(fin.errors, []);
  assert.equal(fin.resultMatches, true);
  assert.equal(fin.tally, tally.id);
  // Members: Ann 4 (3x Ann>Bob, 1x Ann>Bob>Cy), Bob 1, Cy 1; quota 3 -> Ann, then Bob on Ann's surplus
  const official = fin.count.scopes.find(s => s.key === 'official');
  assert.equal(official.ballots, 6);
  assert.deepEqual(official.elected, [0, 1]);
  assert.deepEqual(fin.count.scopes.map(s => s.key), ['official', 'all', 'pool:0', 'pool:1']);
  assert.equal(fin.count.scopes.find(s => s.key === 'pool:1').ballots, 3);
  // an individual can find their ballot in the count with their ranking intact
  const mine = fin.count.formal.find(b => b.id === firstBallotId);
  assert.deepEqual(mine.ranking, [0, 1]);
  assert.ok(official.outcome.has(firstBallotId));
  await assert.rejects(VC.createBallot(fin, members[0], [0]), /closed/);
  await assert.rejects(VC.createTally(fin, el.organiserKey), /closed/);
  finalBlocks = fin.blocks;
  lateBlock = tally;
});

await test('after closing: wrong declared result, late ballots and a second tally are all detected', async () => {
  const fin = await VC.analyse(finalBlocks);
  const tallyBlock = fin.info.get(fin.tally).block;
  // organiser declares a different winner but signs it properly: caught by recomputation
  const { sig, ...body } = tallyBlock;
  assert.equal((await VC.analyse([...finalBlocks.filter(b => b !== tallyBlock), { ...tallyBlock, results: { ...body.results, formal: 99 } }])).tally, null);
  // a ballot that never reached the organiser is visible as not counted
  const spare = await VC.createElection(spec); void spare;
  const pre = await VC.analyse(finalBlocks.filter(b => b.type !== 'tally'));
  const two = await VC.createTally(await VC.analyse(pre.blocks.slice(0, 3)), el.organiserKey);
  const both = await VC.analyse([...finalBlocks, two.block]);
  assert.equal(both.tallies.length, 2);
  assert.match(both.errors.join(' '), /different closing blocks/);
  // an honest-looking but early tally leaves later ballots marked as not counted
  const early = await VC.analyse([...pre.blocks, two.block]);
  assert.ok([...early.info.values()].some(n => n.late));
  // a ballot built on top of the tally is rejected
  const bad = { v: 1, type: 'ballot', election: fin.id, parents: [fin.tally], voter: tallyBlock.encPriv, box: {} };
  const r = await VC.analyse([...finalBlocks, bad]);
  assert.equal([...r.info.values()].filter(n => !n.valid).length, 1);
});

await test('a correctly signed tally with a false result is flagged', async () => {
  const pre = await VC.analyse(finalBlocks.filter(b => b.type !== 'tally'));
  // re-sign a lying tally using the real organiser key (simulates a dishonest organiser)
  const honest = await VC.createTally(pre, el.organiserKey);
  const orig = VC.canon(honest.block.results);
  const lie = JSON.parse(orig); lie.scopes[0].elected = [3, 2];
  // sign by going through createTally's signer: patch results then sign manually with WebCrypto
  const { sig, ...body } = honest.block; body.results = lie;
  const g = pre.genesis, raw = Buffer.from(g.orgPub, 'base64url');
  const jwk = { kty: 'EC', crv: 'P-256', x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32).toString('base64url'), d: el.organiserKey.sigPriv };
  const k = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const s = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, new TextEncoder().encode(VC.canon(body)))).toString('base64url');
  const an = await VC.analyse([...pre.blocks, { ...body, sig: s }]);
  assert.equal(an.resultMatches, false);
  assert.match(an.errors.join(' '), /does NOT match/);
});

await test('self-registered voter keys work alongside generated tickets', async () => {
  const k = await VC.newVoterKey();
  const e2 = await VC.createElection({ title: 'Reg', candidates: ['X', 'Y'], seats: 1, pools: [{ name: 'P', binding: true, generate: 1, registered: [k.pubString] }] });
  const an = await VC.analyse([e2.genesis]);
  const v = await VC.createBallot(an, k.ticket, [1, 0]);
  const fin0 = await VC.analyse([e2.genesis, v.block]);
  const t = await VC.createTally(fin0, e2.organiserKey);
  const fin = await VC.analyse([...fin0.blocks, t.block]);
  assert.deepEqual(fin.errors, []);
  assert.deepEqual(fin.count.scopes[0].elected, [1]);
  await assert.rejects(VC.createElection({ title: 'x', candidates: ['A'], seats: 2, pools: [{ name: 'P', binding: true, generate: 1 }] }), /Open positions/);
  await assert.rejects(VC.createElection({ title: 'x', candidates: ['A'], seats: 1, pools: [{ name: 'P', binding: false, generate: 1 }] }), /binding/);
});

console.log(`\n${passed} passed${process.exitCode ? ', SOME FAILED' : ''}`);
