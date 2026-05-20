---
"compass": patch
---

Pin transitive `vite` via `package.json#overrides: { "vite": "$vite" }` to resolve Dependabot alert [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) (path traversal in Vite's optimized-deps `.map` handling). The direct dependency was already on the patched 6.4.2; only `vitest@2.1.9` was pulling in the affected `vite@5.4.21` transitively. Dev-only impact (the vulnerable code only ran in the test runner's internal Vite), but the override closes the alert and dedupes the lockfile.

The `$vite` substitution means "use the direct dependency's resolved value" — every transitive resolution converges to the same vite version Compass itself runs against (6.4.2 today), and the override automatically tracks any future direct-vite bump. This shape sidesteps npm's `EOVERRIDE` error that fires when override + direct-dep ranges don't match.

`vitest@2.1.9` declares `vite: ^5.0.0` as a peer — the override puts us outside that declared range but all 592 tests run cleanly against vite@6.4.2 (verified locally). The advisory has no vite 5.x backport (vulnerable range covers all of 5.x), so the choice was "override now" vs. a semver-major vitest 4.x bump. Going with the override; tracking the proper vitest upgrade as Phase 6 work.

