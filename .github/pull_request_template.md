## What this changes

<!-- And why. The diff already says what; the "why" is the part reviewers need. -->

## How it was verified

<!-- Which tests, and anything you exercised by hand. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm test:e2e`
- [ ] `pnpm build`

## Checklist

- [ ] New behaviour has tests that assert the behaviour, not the implementation
- [ ] Anything security-relevant has an adversarial test asserting the attack fails
- [ ] Anything time-dependent uses `FakeClock` rather than sleeping
- [ ] No provider-specific branching outside `packages/providers`
- [ ] Anything the gateway now adjusts, substitutes or refuses is recorded on the trace
- [ ] Docs updated if behaviour or configuration changed
- [ ] `CHANGELOG.md` updated for a user-visible change

## Anything reviewers should look at closely

<!-- Tradeoffs you are unsure about, or places you would like a second opinion. -->
