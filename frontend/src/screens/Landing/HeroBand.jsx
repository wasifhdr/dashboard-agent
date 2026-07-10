import { useState } from "react";
import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Field from "../../components/ui/Field.jsx";
import Button from "../../components/ui/Button.jsx";
import HeroReplay from "./HeroReplay.jsx";

export default function HeroBand({ query, onQueryChange, onEnterSearch, onOpenUrl }) {
  const [urlValue, setUrlValue] = useState("");
  const [urlError, setUrlError] = useState("");

  function handleUrlSubmit(e) {
    e.preventDefault();
    const trimmed = urlValue.trim();
    if (!trimmed.toLowerCase().startsWith("http")) {
      setUrlError("Paste a full Tableau Public view URL.");
      return;
    }
    setUrlError("");
    onOpenUrl(trimmed);
  }

  return (
    <section>
      <div className="mx-auto grid max-w-6xl gap-10 px-6 py-16 md:grid-cols-2 md:items-center">
        <div>
          <CapsLabel className="text-teal-ink">VISION-LANGUAGE AGENT · RUNS LOCALLY</CapsLabel>
          <h1 className="mt-2 font-sans text-display font-extrabold text-fg">
            Ask a question. Watch the agent <span className="text-teal-ink">work the dashboard.</span>
          </h1>
          <p className="mt-4 max-w-[55ch] text-[15px] text-fg/70">
            Docent answers questions about live, interactive Tableau dashboards — by operating them the way a
            person would: looking, thinking, filtering, and reading the result. Every step is shown as it happens.
          </p>

          <div className="mt-8 space-y-5">
            <Field
              label="Find a dashboard"
              placeholder='Try "home values", "infectious diseases", "state revenue"…'
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onEnterSearch();
              }}
            />

            <div>
              <label className="mb-1.5 block text-label uppercase text-fg/70">Or open a Tableau Public link</label>
              <form onSubmit={handleUrlSubmit} className="flex items-start gap-2">
                <div className="flex-1">
                  <Field
                    placeholder="https://public.tableau.com/views/Workbook/Sheet"
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    error={urlError || undefined}
                  />
                </div>
                <Button type="submit" variant="primary" className="shrink-0">
                  Open dashboard
                </Button>
              </form>
            </div>
          </div>
        </div>

        <HeroReplay />
      </div>
    </section>
  );
}
