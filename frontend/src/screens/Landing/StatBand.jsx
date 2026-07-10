import StatChip from "../../components/ui/StatChip.jsx";

const STATS = [
  { value: "4B", label: "model parameters", accent: "teal" },
  { value: "6 GB", label: "GPU memory budget", accent: "sky" },
  { value: "15", label: "step budget per question", accent: "gold" },
  { value: "100%", label: "local inference", accent: "green" },
];

export default function StatBand() {
  return (
    <section className="bg-canvas-alt/60">
      <div className="mx-auto flex max-w-6xl flex-wrap justify-center gap-6 px-6 py-16">
        {STATS.map((s) => (
          <StatChip key={s.label} value={s.value} label={s.label} accent={s.accent} />
        ))}
      </div>
    </section>
  );
}
