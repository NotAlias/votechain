# Design: trustee mixing (not implemented)

Status: design only. Nothing in `votechain.html` implements this. It is kept on this branch in case the
single-organiser trust model on `master` stops being enough.

## What it changes

On `master` one organiser holds the only decryption key. They can link every key to its vote, and if they
alter a ballot when publishing it, only that voter can tell (with their receipt).

With mixing, several **trustees** share the key. The encrypted ballots are shuffled by each trustee in turn
before anyone opens them, so:

- linking a key to a vote needs **every** trustee to collude;
- with shuffle proofs, **anyone** can check that the published rankings are the ballots that were cast, not
  only each voter for their own ballot.

The count itself is not done under encryption. STV transfers need whole rankings, so adding up encrypted
counts does not work. A mixnet outputs exactly the set of rankings, with the link to voters removed, and the
existing count runs on that unchanged.

## Building blocks

- **Group:** P-256, the curve already used for signatures. Web Crypto does not expose point arithmetic, so
  point addition, doubling and scalar multiplication are written by hand with `BigInt` (about 150 lines).
  Constant-time behaviour is not achievable in `BigInt`; acceptable here because secrets are only used on the
  trustee's own machine, offline.
- **Encryption:** exponential-free ElGamal on the curve. A ciphertext is `(R, C) = (r·G, M + r·Y)` where `Y`
  is the election key and `M` is a curve point encoding the message.
- **Message encoding:** a ballot for one position is a ranking of at most `n` nominees. Encode it as an
  integer (rank of the permutation prefix, plus one so that blank is distinct), then map to a point by
  try-and-increment on the x coordinate. One ciphertext per position per ballot. If a ranking does not fit in
  about 240 bits (more than roughly 50 nominees), split it over several ciphertexts.
- **Re-encryption:** `(R, C) → (R + s·G, C + s·Y)` for fresh random `s`. Same plaintext, unlinkable
  ciphertext.

## Blocks

Changes and additions to the block types on `master`:

| Block | Signed by | Contents |
|---|---|---|
| `genesis` | organiser | as now, plus `trustees: [{name, sigPub}]` in mixing order. `encPub` and `keyCheck` are removed. |
| `keyshare` | each trustee | `Y_i = x_i·G` and a Schnorr proof of knowledge of `x_i`. The election key is `Y = ΣY_i`. Voting opens once every trustee's share is in the chain. |
| `ballot` | voter | as now, but `box` is one ElGamal ciphertext per position, each with a Schnorr proof of knowledge of `r` bound to the voter key and election ID (stops ciphertext copying, replacing today's AAD binding). |
| `seal` | organiser | closes voting. Parents are every tip. Fixes the counted ballots and their pools by the rules on `master`, and lists the input ciphertexts per pool per position in ballot-ID order. |
| `mix` | trustee `i` | parent is the previous `mix` (or `seal`). For each pool and position: the shuffled, re-encrypted list, plus the shuffle proof. |
| `share` | each trustee | parent is the last `mix`. For each output ciphertext `(R, C)`: `D_i = x_i·R` and a Chaum-Pedersen proof that `log_G(Y_i) = log_R(D_i)`. |
| `tally` | organiser | parents are all `share` blocks. Declares the result. The rankings are no longer carried in it; anyone derives them as `M = C − ΣD_i` and decodes. |

Mixing is done **per pool and per position** separately. That keeps pools apart for the pool results, and
means a person's choices across positions cannot be reassembled, as on `master`.

## Shuffle proof

The simple option, in the style of Sako-Kilian and the first Helios: cut and choose with shadow mixes.

1. The trustee shuffles input list `A` into output list `B` with permutation `π` and re-encryption values `s`.
2. They also produce `k = 40` shadow lists `S_1…S_k`, each an independent shuffle of `A`.
3. Challenge bits come from Fiat-Shamir: `SHA-256(election ID, A, B, S_1…S_k)`.
4. For each shadow: bit 0 reveals how `A` maps to `S_j`; bit 1 reveals how `S_j` maps to `B`. Either can be
   checked by re-encrypting; neither alone reveals `π`.

A cheating trustee is caught except with probability `2^-40`. Cost: `k` extra lists per mix, so the file grows
by roughly 40 times the ballot data per trustee. For a few hundred ballots that is a few megabytes. A
Bayer-Groth or Neff proof is far smaller but much harder to implement correctly by hand.

A cheaper variant drops the proofs and relies on receipts alone: privacy still needs only one honest
trustee, but a substituted ballot is then visible only to its voter, the same as on `master`.

## Receipts

The per-voter check on `master` uses a random code inside the encrypted ballot. With one ciphertext per
position there is no room for a 128-bit code next to the ranking in a single point, so either:

- add a second ciphertext per position carrying the code, mixed in lock-step with the ranking (same
  permutation, proven together); or
- drop receipts and rely on the shuffle and decryption proofs, which already show that every counted ballot
  went in and came out unaltered.

With full proofs the second option is sound and removes the receipt as something a voter could be made to
hand over. The "what was counted" table still works.

## Flow

1. Organiser creates the genesis block naming the trustees.
2. Each trustee adds a `keyshare` block. Organiser merges and shares the chain file.
3. Voters vote in parallel and post their files, as now.
4. Organiser merges, admits where needed, and adds `seal`.
5. Trustee 1 adds `mix`, posts the file. Trustee 2 loads it, adds `mix`, posts. And so on.
6. Each trustee adds a `share` block on the last mix. These can be done in parallel and merged.
7. Organiser adds `tally`. Everyone verifies.

## What it costs

- **More people must act.** Steps 2, 5 and 6 need every trustee, and step 5 is strictly sequential.
- **A lost key is fatal.** Decryption needs all trustees (`n` of `n`). Losing one key means the election
  cannot be opened. A `t` of `n` threshold fixes that but needs a distributed key generation protocol with
  several rounds between trustees, which sits badly with a post-a-file workflow.
- **Hand-written curve maths** is the riskiest code in the project and needs test vectors against a known
  implementation.
- **File size**, as above.
- **The last trustee to decrypt sees the result first** and could refuse to publish their share. The
  remedy is social: they are named in the genesis block.

## What stays the same

Block graph and merging, signatures, pools, the open pool and admissions, one ballot per key, the rule that
omitting a ballot posted before closing invalidates the result, the STV count and tie-breaks, and the Results
tab.

## Build order, if this is ever picked up

1. Curve arithmetic, ElGamal, Schnorr and Chaum-Pedersen proofs, with test vectors.
2. `keyshare`, new `ballot` box, `seal`, `share`, with a single trustee and no mixing. This already replaces
   the organiser key with a provably correct decryption.
3. `mix` without proofs, then the shadow-mix proof.
4. Trustee tab in the UI.
5. Decide on receipts.
