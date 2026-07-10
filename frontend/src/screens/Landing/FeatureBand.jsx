import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Card from "../../components/ui/Card.jsx";

const FEATURES = [
  {
    title: "Sees the dashboard",
    body: "No data exports, no CSV back doors. Docent answers from rendered pixels, so it works on dashboards it has never seen before.",
    accent: "green",
  },
  {
    title: "Shows every step",
    body: "Thoughts, actions, and view changes stream live and are stored for replay. The answer arrives with its full trajectory.",
    accent: "gold",
  },
  {
    title: "Operates real Tableau",
    body: "Semantic actions through the Tableau Embedding API — filters, parameters, and sheet tabs, not blind clicking.",
    accent: "sky",
  },
  {
    title: "Runs on one laptop",
    body: "A quantized 4B VLM on a 6 GB GPU via llama.cpp. No cloud calls, no API keys, nothing leaves the machine.",
    accent: "violet",
  },
];

export default function FeatureBand() {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-16">
        <CapsLabel className="text-teal-ink">WHY IT'S INTERESTING</CapsLabel>
        <h2 className="mt-2 text-h1">Built to show its work.</h2>
        <div className="mt-8 grid gap-5 md:grid-cols-4">
          {FEATURES.map((f) => (
            <Card key={f.title} variant="standard" accent={f.accent}>
              <h3 className="text-h3">{f.title}</h3>
              <p className="mt-2 text-sm text-fg/70">{f.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
