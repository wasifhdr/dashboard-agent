# Brand font

The header/footer wordmark ("DashLens") is set in **Bungee Shade**,
applied via `.brand-wordmark` in `frontend/src/index.css`. It ships as
`bungee.shade-regular.woff2` and is committed to the repo like any other
static asset — see "Licence" below for why that's safe here.

Nothing else in the app uses it, and nothing else should: keep the wordmark
as the one place this face appears.

## Licence

Bungee Shade is part of the Bungee family by David Jonathan Ross, distributed
as a Google Font under the **SIL Open Font License (OFL)**. The OFL permits
embedding, redistribution, and modification (including subsetting), so unlike
the legacy fonts below, there's no restriction on committing it to a public
repo.

## Legacy: Transcity and Bilderberg

`Transcity.woff2` and `bilderberg.regular.woff2` may still exist in this
folder locally, but neither is referenced by any `font-family` in the app —
both were earlier wordmark candidates, superseded by Bungee Shade, and their
`@font-face` rules in `index.css` are unused. They stay **git-ignored** (see
the repo-root `.gitignore`) because their licences are more restrictive or
unconfirmed:

- **Transcity** is a free-for-personal-use 1001Fonts FFP demo release. Its
  licence (`transcity/1001fonts-transcity-eula.txt`) permits webfont
  conversion and embedding but explicitly forbids publishing or
  redistribution (§6, §7) — committing it to this public repo would breach
  that. To restore it locally: put the vendor `.otf` at
  `transcity/Transcity DEMO.otf` and convert with
  `python -c "from fontTools.ttLib import TTFont; f=TTFont('transcity/Transcity DEMO.otf'); f.flavor='woff2'; f.save('frontend/public/fonts/Transcity.woff2')"`
  (requires `pip install fonttools brotli`; convert only — don't subset or
  rename, per licence §4/§5).
- **Bilderberg**'s licence terms haven't been checked, so it's git-ignored by
  the same conservative default.

If either is ever wired back into `.brand-wordmark`, re-verify its licence
first and update this file and the root `.gitignore` accordingly.

## Gotcha: a missing font does not 404 in dev

Vite answers unknown `/public` paths with the SPA `index.html` at **200**, not
`404`. So if `bungee.shade-regular.woff2` goes missing, the browser downloads
HTML, fails to parse it as a font, and logs `OTS parsing error` about eight
times per page load. That warning is the signature of this file being absent
— the wordmark still renders (falling back to Inter), so the console is the
only symptom.
