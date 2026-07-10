import CapsLabel from "../../components/ui/CapsLabel.jsx";
import Card from "../../components/ui/Card.jsx";

const STEPS = [
  {
    n: "01",
    title: "Perceive",
    body: "Takes a screenshot of the live dashboard — the same pixels you would see.",
    accent: "teal",
  },
  {
    n: "02",
    title: "Think",
    body: "A local 4-billion-parameter vision-language model reads the view and picks one next move.",
    accent: "sky",
  },
  {
    n: "03",
    title: "Act",
    body: "Applies real filters, parameters, and tab switches through the Tableau Embedding API.",
    accent: "gold",
  },
  {
    n: "04",
    title: "Observe",
    body: "Waits for the dashboard to settle, re-reads it, and repeats until it can answer.",
    accent: "green",
  },
];

export default function HowItWorksBand() {
  return (
    <section className="bg-canvas-alt/70">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <CapsLabel className="text-green-ink">THE LOOP</CapsLabel>
        <h2 className="mt-2 font-sans text-display-sm font-extrabold text-fg">
          Perceive. Think. Act. <span className="text-green-ink">Observe.</span>
        </h2>
        <div className="mt-8 grid gap-5 md:grid-cols-4">
          {STEPS.map((s) => (
            <Card key={s.n} variant="quiet" accent={s.accent}>
              <div className="font-mono text-sm text-fg/50">{s.n}</div>
              <h3 className="mt-2 text-h3">{s.title}</h3>
              <p className="mt-1 text-sm text-fg/70">{s.body}</p>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
