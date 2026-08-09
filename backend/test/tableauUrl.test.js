import test from "node:test";
import assert from "node:assert/strict";

import { normalizeTableauViewUrl } from "../src/tableauUrl.js";

test("the canonical embed URL is left exactly as it is", () => {
  const url = "https://public.tableau.com/views/VideoGameSales-Dashboard/VideoGamePublishers";
  assert.deepEqual(normalizeTableauViewUrl(url), { url, rewritten: false });
});

test("REGRESSION: the /app/profile browse URL is rewritten to the embed form", () => {
  // What Tableau Public shows in the address bar while you are looking at a
  // viz, so it is the URL a user actually copies. Left alone it produces a 90s
  // wait and then a failed open, because the embedding API cannot load it.
  const out = normalizeTableauViewUrl(
    "https://public.tableau.com/app/profile/chloedotbrown/viz/AirBnBinEastvs_WestBerlin/AirBnBBerlin",
  );
  assert.deepEqual(out, {
    url: "https://public.tableau.com/views/AirBnBinEastvs_WestBerlin/AirBnBBerlin",
    rewritten: true,
  });
});

test("a profile name containing dots and digits is still handled", () => {
  const out = normalizeTableauViewUrl("https://public.tableau.com/app/profile/first.last8020/viz/WB_123/Sheet1");
  assert.equal(out.url, "https://public.tableau.com/views/WB_123/Sheet1");
});

test("viewer query params are dropped - they are not part of the embed URL", () => {
  const out = normalizeTableauViewUrl(
    "https://public.tableau.com/app/profile/someone/viz/Book/View?publish=yes&:language=en-US",
  );
  assert.equal(out.url, "https://public.tableau.com/views/Book/View");
});

test("trailing segments after the view name are dropped", () => {
  const out = normalizeTableauViewUrl("https://public.tableau.com/app/profile/someone/viz/Book/View/extra");
  assert.equal(out.url, "https://public.tableau.com/views/Book/View");
});

test("http is upgraded along with the rewrite, since Tableau serves https", () => {
  const out = normalizeTableauViewUrl("http://public.tableau.com/app/profile/x/viz/Book/View");
  assert.equal(out.url, "https://public.tableau.com/views/Book/View");
});

test("a non-Tableau URL is passed through untouched", () => {
  const url = "https://example.com/app/profile/x/viz/Book/View";
  assert.deepEqual(normalizeTableauViewUrl(url), { url, rewritten: false });
});

test("an /app/ URL that is not a viz link is passed through rather than guessed at", () => {
  const url = "https://public.tableau.com/app/profile/chloedotbrown";
  assert.deepEqual(normalizeTableauViewUrl(url), { url, rewritten: false });
});

test("garbage input is returned unchanged instead of throwing", () => {
  assert.deepEqual(normalizeTableauViewUrl("not a url"), { url: "not a url", rewritten: false });
  assert.deepEqual(normalizeTableauViewUrl(""), { url: "", rewritten: false });
  assert.deepEqual(normalizeTableauViewUrl(null), { url: null, rewritten: false });
});
