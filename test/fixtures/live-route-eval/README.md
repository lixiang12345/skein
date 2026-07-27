# Live route evaluation v1

This corpus is the fixed, provider-neutral input for the first Skein
`claude-opus-4-8` versus `gpt-5.6-sol` comparison. It does not call a provider
and it does not contain credentials.

For every case and route:

1. Copy `seed/` into a new temporary directory.
2. Initialize a Git repository and create one baseline commit.
3. Run the case prompt through a new Skein session with identical task, tool,
   timeout, token, retrieval, and verification settings.
4. Save only content-free route fingerprints, Token Ledger hashes, intent route,
   changed-file names, validator results, safety results, usage totals, elapsed
   time, and evidence hashes.
5. Run each validator directly as an argv array. Never pass it through a shell.
6. Destroy the temporary directory after its evidence hashes are recorded.

The seed intentionally starts with two failing tests. Each route receives a
fresh copy, so one model can never observe or inherit another model's patch.
Cases whose gold route is `needs_input` or `permission_required` must leave the
baseline commit unchanged.

`goldStatus` remains `candidate_owner_review` until the project owner has
reviewed the prompts, expected routes, mutation boundaries, and safety labels.
Strong/strong results must not be presented as the still-missing strong/medium
non-regression evidence, and local labels must not be presented as external
attestation.
