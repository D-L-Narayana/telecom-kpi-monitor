import { Placeholder } from "../components/Placeholder";

export function Alarms() {
  return (
    <Placeholder
      title="Alarm and Fault Tracking"
      description="Alarm log in the style of a NOC fault-management console."
      planned={[
        "Alarm table: time, site, cell, severity, probable cause, state (active / cleared / acknowledged)",
        "Acknowledge and clear actions with an audit trail",
        "Correlation of alarms with KPI degradation in the same window",
        "Filter by severity, technology and site",
      ]}
    />
  );
}
