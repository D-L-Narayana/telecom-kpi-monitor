import { Placeholder } from "../components/Placeholder";

export function Packets() {
  return (
    <Placeholder
      title="Packet Statistics"
      description="Wireshark-style summary statistics for a synthetic capture (protocol hierarchy, conversations, retransmissions)."
      planned={[
        "Protocol hierarchy: GTP-U, S1AP/NGAP, SCTP, TCP/UDP, DNS, SIP/RTP",
        "Top conversations by bytes and packets",
        "TCP retransmission / RTT summary as a QoS indicator",
        "Import of a JSON/CSV export produced from a .pcap (tshark -T json)",
      ]}
    />
  );
}
