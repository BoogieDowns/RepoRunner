import { AppPhase } from "@/types";

interface TopBarProps {
  phase: AppPhase;
}

const PHASE_LABELS: Record<AppPhase, string> = {
  landing:  "STANDBY",
  scanning: "SCANNING",
  analysis: "ANALYSIS",
  running:  "ONLINE",
};

export function TopBar({ phase }: TopBarProps) {
  const isOnline   = phase === "running";
  const isScanning = phase === "scanning";

  return (
    <div
      className="fixed top-0 left-0 right-0 h-8 z-50 flex items-center px-5 gap-4 select-none"
      style={{
        background: "rgba(8,8,8,0.96)",
        borderBottom: "1px solid rgba(255,255,255,0.055)",
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Brand */}
      <span
        className="font-mono text-[11px] font-bold tracking-[0.18em] uppercase"
        style={{ color: "#cc2222", letterSpacing: "0.18em" }}
      >
        Repo Runner
      </span>

      {/* Badge */}
      <span
        className="font-mono text-[9px] tracking-[0.14em] uppercase px-1.5 py-[2px]"
        style={{
          color: "#333333",
          border: "1px solid #1e1e1e",
          letterSpacing: "0.14em",
        }}
      >
        Dev Console
      </span>

      <div className="flex-1" />

      {/* Nav items */}
      <div className="hidden sm:flex items-center gap-6">
        {["Analyze", "Logs", "Settings"].map((label) => (
          <span
            key={label}
            className="font-mono text-[10px] tracking-[0.1em] uppercase cursor-default"
            style={{ color: "#2e2e2e" }}
          >
            {label}
          </span>
        ))}
      </div>

      <div className="w-px h-3.5 mx-1" style={{ background: "#1a1a1a" }} />

      {/* Phase status */}
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-[9px] tracking-[0.12em] uppercase"
          style={{ color: isOnline ? "#888" : isScanning ? "#666" : "#2a2a2a" }}
        >
          {PHASE_LABELS[phase]}
        </span>
        <span
          className={isOnline || isScanning ? "animate-pulse-dot" : ""}
          style={{
            display: "inline-block",
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: isOnline ? "#cc2222" : isScanning ? "#884422" : "#1e1e1e",
            boxShadow: isOnline ? "0 0 6px #cc2222" : "none",
          }}
        />
      </div>

      <div className="w-px h-3.5 mx-1" style={{ background: "#1a1a1a" }} />

      {/* System ID */}
      <span
        className="font-mono text-[9px] tracking-[0.1em] uppercase hidden sm:block"
        style={{ color: "#222" }}
      >
        SYS-7742
      </span>
    </div>
  );
}
