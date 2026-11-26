# Votechain

Distributed, anonymous, proportional voting in one HTML file. No server, no install, no network access:
voters open `votechain.html`, load a chain file, add their encrypted ballot, and post the new file where the
organiser can collect it (a Discord channel works).

## How an election runs

1. **Organiser calls the election** (Organiser tab). They set the title, the positions (each with its own
   nominees and number to elect), the voter pools, and optionally how many people are entitled to vote. The
   page produces:
   - the **chain file** containing the genesis block, to share with every voter;
   - the **organiser key**, which is secret and stays secret for good;
   - a **ticket list**, if they chose to generate tickets, one secret ticket per voter.
2. **Voters vote, all in parallel** (Vote tab). Load the chain file, paste a ticket or generate a key on the
   spot, rank the nominees for each position, cast. The page downloads an updated chain file and shows a
   **receipt**. The voter posts the chain file publicly. It reveals nothing about their choices.
3. **Organiser merges** (Chain file tab) by dropping every posted file onto the page.
4. **Organiser admits voters** (Organiser tab) where needed: see "Pools and the unverified escape hatch".
5. **Organiser closes the election** (Organiser tab). The page decrypts the ballots locally and adds the
   closing block: the anonymous ballots and the result.
6. **Everyone verifies** (Results and Check my vote tabs) from the final chain file.

Announce the **election ID** (shown after creation) through a channel voters trust, so they can tell the real
genesis block from a fake one.

## Pools and the unverified escape hatch

Every counted ballot sits in exactly one pool. The default setup has two:

- **Verified**: keys the organiser vouches for. A key gets here by using a ticket the organiser generated, by
  being listed in the genesis block, or by being admitted later.
- **Unverified**: an *open* pool. Any key can vote here with no ticket, so nobody is ever locked out.

Someone who should be verified but has no ticket generates their own key, votes (landing in Unverified), then
tells the organiser "this public key is mine". The organiser confirms who they are and signs an **admission
block** moving that key to Verified, with their name attached. That person's participation is now public; how
they voted is not.

Results are published for all pools combined and for each pool on its own. If the genesis block states how many
people are entitled to vote, the page warns when more ballots than that turn up. When the numbers add up and
the organiser has confirmed everyone, the combined result can be used; otherwise the Verified-only result is
there.

## What is in the chain

A chain file is `{ "format": "votechain/1", "blocks": [...] }`. A block's ID is the SHA-256 of its canonical
JSON without the signature. Blocks name their parents by ID, so the chain is a graph like git history, and any
two files for the same election merge by taking the union of their blocks.

| Block | Signed by | Contains |
|---|---|---|
| `genesis` | organiser | title, positions and nominees, pools, voter roll, expected number of voters, organiser signing key, ballot encryption key |
| `ballot` | the voter's key | parents, voter public key, the rankings encrypted to the organiser |
| `admit` | organiser | parents, list of voter public key, pool and name |
| `tally` | organiser | parents (every tip at closing), the anonymous ballots per pool and position, IDs of unreadable ballots, the declared result |

Crypto is the browser's Web Crypto API only: ECDSA P-256 signatures, ephemeral ECDH P-256 with HKDF and
AES-256-GCM for ballots (padded to a fixed size), PBKDF2 for the optional passphrase on the organiser key file.

### How the count stays anonymous but checkable

Each ballot contains a random **receipt code** that only the voter and, after decryption, the organiser ever
see. The closing block lists each counted ballot's ranking for each position under a code derived from that
receipt code (a different one per position), sorted by code. Nothing in it refers to a voter key, and the
decryption key is never published.

- **Anyone** can check: every signature; which ballots had to be counted and in which pool; that the organiser
  published exactly that many anonymous ballots per pool; and that the declared result is what those ballots
  produce.
- **Each voter** can check, with their receipt, that their own ballot is among them, unaltered.
- **Nobody but the organiser** can tell which key cast which ballot. A voter who has lost or deleted their
  receipt cannot show anyone how they voted. A receipt is also weak evidence once the result is public,
  because the published codes of other people's ballots cannot be told apart from your own without it.

### Rules the page enforces

- One ballot per key. A ballot built on top of the same key's earlier ballot loses to it; between unrelated
  ballots the lowest ID wins.
- Admissions: if a key is admitted more than once, the latest block wins.
- Only blocks that the closing block builds on count. Nothing may build on a closing block.
- Two different closing blocks are reported as a dispute.
- The count is single transferable vote per position: Droop quota, weighted inclusive Gregory surplus
  transfers, exact fractions. Electing one person is instant-runoff voting.
- Ties: when nominees are level, the one with more first preferences is placed ahead; then the one ahead in
  the earliest later round where their totals differ; then the one with more second preferences on all
  ballots, then third preferences, and so on. Only nominees level on all of that are separated by a lot
  derived from the chain. The round-by-round table says which step decided each tie.

### What the Results tab shows

For every position, in every pool and for all pools combined: who was elected, the count round by round, and
**what was counted** as a set of distinct rankings with the number of ballots that gave each (for example
`10 × Ann, Cy, Bob` and `2 × Bob, Ann`), including ballots left blank for that position. Below that are the
list of keys whose ballots counted and the anonymous ballots one by one.

## What rests on the organiser

The organiser is trusted and accountable, by design:

- **They can read every ballot and link it to a key**, and to a person where they know whose key it is. They
  should delete the organiser key once the result is accepted.
- **They can leave a ballot out** by not merging it before closing. The voter sees it marked as not part of
  the closed chain, and anyone who loads the final file together with the voter's posted file sees the same
  warning. A ballot posted before closing and left out invalidates the result.
- **They can alter a ballot's content** when publishing it. The public checks cannot see that; the voter can,
  with their receipt. This protection is only as strong as the number of voters who check.
- **They can cast extra ballots** in the open pool, or with tickets they generated. The open pool is
  untrusted by definition; for the verified pool, having voters generate their own keys and admitting them
  avoids organiser-held tickets entirely.
- Small pools leak: a pool with one ballot shows how that person voted.
- There is no public clock. "Closed" means the organiser signed a closing block; the time a file was posted
  is whatever the channel it was posted in says.

This is suitable for clubs, committees and member organisations with an accountable returning officer. It is
not suitable for public elections.

## Tests

`node test/run-tests.mjs` (Node 20 or newer) runs the logic embedded in the HTML file: the count, parallel
voting and merging, admissions, duplicate and forged blocks, closing, receipts, and detection of a dishonest
closing block.
