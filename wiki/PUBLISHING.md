# Publishing this wiki to GitHub

These pages are authored in this folder so they're versioned alongside the code. GitHub Wikis are
backed by a **separate git repo** (`<repo>.wiki.git`). That repo does **not exist until the first
wiki page is created through the GitHub web UI** — which is why a plain clone/push fails on a brand-
new wiki.

## One-time bootstrap (required once)

1. Go to **https://github.com/sandgraal/compass/wiki** and click **Create the first page**.
2. Save any placeholder content (it will be overwritten). This initializes `compass.wiki.git`.

## Publish (after bootstrap)

From the repo root:

```bash
./wiki/publish.sh
```

Or manually:

```bash
git clone https://github.com/sandgraal/compass.wiki.git /tmp/compass-wiki
cp wiki/*.md /tmp/compass-wiki/
cd /tmp/compass-wiki
git add -A
git commit -m "docs(wiki): comprehensive Compass documentation"
git push
```

## Notes

- `Home.md` is the wiki landing page. `_Sidebar.md` and `_Footer.md` render on every page.
- Page links use GitHub-wiki filename slugs (hyphens for spaces), e.g. `[Finance](Finance)`.
- Re-run `publish.sh` whenever you update these source files to keep the wiki in sync.
