---
"compass": patch
---

Pin transitive `vite` to `^6.4.2` via `package.json#overrides` to resolve Dependabot alert [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) (path traversal in Vite's optimized-deps `.map` handling). The direct dependency was already on the patched 6.4.2; only `vitest@2.1.9` was pulling in the affected `vite@5.4.21` transitively. Dev-only impact (the vulnerable code only ran in the test runner's internal Vite), but the override closes the alert and dedupes the lockfile.
