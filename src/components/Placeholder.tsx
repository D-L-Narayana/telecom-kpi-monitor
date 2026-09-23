type Props = {
  title: string;
  description: string;
  planned: string[];
};

/** Temporary page body used while the real views are being built (see PLAN.md). */
export function Placeholder({ title, description, planned }: Props) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="muted">{description}</p>
      <h2>Planned in this view</h2>
      <ul>
        {planned.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="status">Status: scaffold only - not implemented yet.</p>
    </section>
  );
}
