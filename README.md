# Votechain

Distributed, pseudonymous, proportional voting in one HTML file. No server, no install, no network access:
voters open `votechain.html`, load a chain file, add their ballot, and pass the new chain file on.

## How an election runs

1. **Organiser calls the election** (Organiser tab). They set the title, the candidates, the number of open
   positions and the voter pools. The page produces three files:
   - the **chain file** containing the genesis block, to share with every voter;
   - the **organiser key**, which is secret and needed to close the election;
   - a **ticket list**, one secret ticket per voter, to hand out privately.
2. **Voters vote** (Vote tab). Load the chain file, paste the ticket, rank the candidates, cast. The page
   downloads an updated chain file with the ballot block added. The voter sends that file back.
3. **Anyone merges** (Chain file tab). Dropping several chain files for the same election onto the page
   merges them. Voters can all work from the original genesis file at the same time, or pass one file along.
4. **Organiser closes the election** (Organiser tab). After merging everything received, the organiser adds
   the final block. It contains the declared result and the ballot decryption key.
5. **Everyone verifies** (Results and Check my vote tabs). Loading the final chain file decrypts every ballot,
   re-runs the count locally and compares it with the organiser's signed result.

Announce the **election ID** (shown after creation) through a channel voters trust, so they can tell the real
genesis block from a fake one.

## What the blocks are

A chain file is `{ "format": "votechain/1", "blocks": [...] }`. A block's ID is the SHA-256 of its canonical
JSON without the signature. Blocks name their parents by ID, so the chain is a graph like git history: a new
block builds on every current tip, which is what makes any two files mergeable by taking the union of blocks.

| Block | Signed by | Contains |
|---|---|---|
| `genesis` | organiser | title, candidates, open positions, pools, voter roll (public key and pool per voter), organiser signing key, ballot encryption key |
| `ballot` | the voter's ticket key | parents, voter public key, the ranking encrypted to the election key |
| `tally` | organiser | parents (every tip at closing time), the released decryption key, the declared result |

Crypto is the browser's Web Crypto API only: ECDSA P-256 signatures, ephemeral ECDH P-256 with HKDF and
AES-256-GCM for ballots, PBKDF2 for the optional passphrase on the organiser key file.

## How each requirement is met

- **Was my vote counted?** The Check my vote tab takes a ticket, public key, ballot ID or receipt. Against the
  final chain it shows whether the ballot is in the count, the ranking it was counted as, and which candidates
  its value ended up with.
- **Pools.** Every voter key on the roll belongs to one pool, fixed in the genesis block. Binding pools decide
  the official result. The count is also published for each pool separately and for all pools combined.
- **Proportional.** The count is single transferable vote: Droop quota, weighted inclusive Gregory surplus
  transfers, exact fractions (no rounding). Exact ties are broken by the previous rounds, then by a lot derived
  from the hashes of the counted ballots. With one open position it is instant-runoff voting.
- **Fixed candidates and positions.** Both are in the signed genesis block; changing them changes the election ID.
- **Verifiable final count.** The tally block releases the decryption key, so every copy of the page recomputes
  the result and flags a mismatch.

Rules the verifier enforces: one ballot per voter key (a ballot built on top of the same voter's earlier
ballot loses to it; between unrelated ballots the lowest ID wins); nothing may build on a tally block; only
ballots that are ancestors of the tally block are counted; two different tally blocks are reported as a dispute.

## What this does and does not protect

The organiser is trusted and accountable, by design. Specifically:

- **The organiser can link voters to votes** if they record who received which ticket. Handing tickets out
  blind (for example drawn from a hat) removes that link. Self-registered keys always make the link known to
  the organiser.
- **The organiser can read ballots at any time**, since they hold the decryption key.
- **The organiser can cast votes with tickets they generated**, including ones never handed out. Turnout per
  pool is public, so this shows up as unexpected turnout but cannot be proven. Asking voters to generate their
  own keys (Vote tab, "Make your own voter key") and register the public half prevents it.
- **The organiser can leave a ballot out** by not merging it before closing. The voter will see that in Check
  my vote and still holds the signed ballot as evidence, but cannot prove it was sent in time.
- **Whoever receives your chain file can see which voter key added the newest block**, and after closing, how
  that key voted. Send your file to the organiser rather than passing it voter to voter if that matters.
- **After closing, every ballot is public** against its voter key. That is what makes the count checkable.
- **Receipts allow a voter to prove how they voted**, so this does not resist vote buying or coercion.
- There is no public timestamp. "Closed" means the organiser signed a tally block.

This is suitable for clubs, committees and member organisations that already trust a returning officer. It is
not suitable for public elections.

## Tests

`node test/run-tests.mjs` (Node 20 or newer) runs the logic embedded in the HTML file: the STV count, forking
and merging, duplicate and forged ballots, closing, and detection of a false declared result.
