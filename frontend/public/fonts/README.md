# Brand font

The header/footer wordmark ("Dashboard Agent") is set in **Transcity**, applied
via `.brand-wordmark` in `frontend/src/index.css`. It is not on Google Fonts or
fontsource, so it is not an npm dependency — it loads from this folder as
`Transcity.woff2`.

Nothing else in the app uses it, and nothing else should: the face carries
**letters and space only** — no digits, no punctuation. Any string with a comma
or a number in it will render partly in Inter.

## The file is deliberately NOT committed

`*.woff2` here is git-ignored, along with the vendor folder `transcity/` at the
repo root. **This repo is public**, and Transcity is a free-for-personal-use
demo release whose licence (`transcity/1001fonts-transcity-eula.txt`) permits
conversion and embedding but not publication:

> §6 Distribution — "it may not be sold or published without written permission"
> §7 Embedding — allowed "as long as the application … does not distribute
> Transcity, such as offering it as a download"

A public GitHub repo does offer it as a download, so committing it would breach
both. Consequence: **a fresh clone renders the wordmark in Inter**, not
Transcity. That is a deliberate trade, not a bug.

To ship the real wordmark publicly, buy a commercial/webfont licence from
<https://dharmasstudio.com/transcity> and re-check the terms — the demo is also
personal-use-only, which a public project arguably already strains.

## Restoring it on a new machine

1. Put the vendor `.otf` at `transcity/Transcity DEMO.otf`.
2. Convert to WOFF2 (roughly halves it, 19KB → 9.5KB):

   ```bash
   python -m pip install fonttools brotli
   ```

   ```bash
   python -c "from fontTools.ttLib import TTFont; f=TTFont('transcity/Transcity DEMO.otf'); f.flavor='woff2'; f.save('frontend/public/fonts/Transcity.woff2')"
   ```

Convert only — do not subset or rename. Licence §5 allows format conversion;
§4 forbids modifying the font in any other way, and subsetting drops glyphs.

## Gotcha: a missing font does not 404 in dev

Vite answers unknown `/public` paths with the SPA `index.html` at **200**, not
`404`. So if `Transcity.woff2` goes missing, the browser downloads HTML, fails
to parse it as a font, and logs `OTS parsing error` about eight times per page
load. That warning is the signature of this file being absent — the wordmark
still renders (falling back to Inter), so the console is the only symptom.
