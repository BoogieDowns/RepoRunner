import { useState } from "react";
import { RunPlan } from "@/types";
import { TopBar } from "./TopBar";

interface AnalysisScreenProps {
  plan: RunPlan;
  onLaunch: () => void;
  onBack: () => void;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      className="flex items-baseline justify-between py-3 gap-4"
      style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
    >
      <span className="font-mono text-[10px] tracking-[0.12em] uppercase flex-none" style={{ color: "#333" }}>
        {label}
      </span>
      <span className="font-mono text-[12px] text-right truncate" style={{ color: "#888" }}>
        {value}
      </span>
    </div>
  );
}

function StatusTag({ status }: { status: "READY" | "MISSING" | "OPTIONAL" | "WARNING" }) {
  const styles: Record<string, { color: string; border: string }> = {
    READY:    { color: "#3a6644", border: "rgba(40,90,60,0.5)" },
    MISSING:  { color: "#cc2222", border: "rgba(204,34,34,0.4)" },
    OPTIONAL: { color: "#333",    border: "rgba(255,255,255,0.07)" },
    WARNING:  { color: "#996633", border: "rgba(180,120,40,0.4)" },
  };
  const s = styles[status] ?? styles.OPTIONAL;
  return (
    <span
      className="font-mono text-[9px] tracking-[0.1em] uppercase px-2 py-[3px] flex-none"
      style={{ color: s.color, border: `1px solid ${s.border}` }}
    >
      {status}
    </span>
  );
}

export function AnalysisScreen({ plan, onLaunch, onBack }: AnalysisScreenProps) {
  const [launching, setLaunching] = useState(false);

  const missingRequired = plan.envVars.filter((v) => v.required && !v.hasValue);
  const isBlocked = plan.readiness === "blocked";

  const handleLaunch = async () => {
    setLaunching(true);
    await window.repoRunner.launchPreview();
    onLaunch();
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#080808" }}>
      <TopBar phase="analysis" />

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-6 py-16 pt-20">

          {/* Header */}
          <div className="mb-10">
            <div className="font-mono text-[10px] tracking-[0.2em] uppercase mb-2" style={{ color: "#2a2a2a" }}>
              ── Run Plan
            </div>
            <div
              className="font-mono font-bold tracking-tight"
              style={{ fontSize: "1.6rem", color: "#c0c0c0", letterSpacing: "-0.01em" }}
            >
              {plan.projectName}
            </div>
            <div className="font-mono text-[11px] mt-1 truncate" style={{ color: "#333" }}>
              {plan.repoUrl}
            </div>
          </div>

          {/* Thin divider */}
          <div className="mb-8" style={{ height: 1, background: "rgba(255,255,255,0.05)" }} />

          {/* Project info */}
          <div className="mb-10">
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-4" style={{ color: "#222" }}>
              Detected Configuration
            </div>
            <InfoRow label="Framework"        value={plan.framework} />
            <InfoRow label="Package Manager"  value={plan.packageManager} />
            <InfoRow label="Install Command"  value={plan.installCommand} />
            <InfoRow label="Start Command"    value={plan.startCommand} />
            <InfoRow label="Port"             value={String(plan.port)} />
            <InfoRow label="Branch"           value={plan.branch} />
            <InfoRow label="Runtime"          value={plan.runtime} />
          </div>

          {/* Env vars */}
          <div className="mb-10">
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-4" style={{ color: "#222" }}>
              Environment Requirements
            </div>
            <div className="flex flex-col">
              {plan.envVars.map((ev) => (
                <div
                  key={ev.name}
                  className="flex items-center gap-4 py-3"
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                >
                  <span className="font-mono text-[11px] flex-1" style={{ color: ev.required && !ev.hasValue ? "#884444" : "#444" }}>
                    {ev.name}
                  </span>
                  {ev.description && (
                    <span className="font-mono text-[10px] hidden sm:block" style={{ color: "#222" }}>
                      {ev.description}
                    </span>
                  )}
                  <StatusTag status={ev.hasValue ? "READY" : ev.required ? "MISSING" : "OPTIONAL"} />
                </div>
              ))}
            </div>
          </div>

          {/* Readiness banner */}
          {missingRequired.length > 0 && (
            <div
              className="mb-8 px-4 py-3 flex items-start gap-3"
              style={{ border: "1px solid rgba(204,34,34,0.2)", background: "rgba(204,34,34,0.04)" }}
            >
              <span className="font-mono text-[10px] mt-px" style={{ color: "#cc2222" }}>⚠</span>
              <div>
                <div className="font-mono text-[10px] tracking-[0.1em] uppercase mb-1" style={{ color: "#cc2222" }}>
                  Missing Input
                </div>
                <div className="font-mono text-[11px]" style={{ color: "#555" }}>
                  {missingRequired.length} required env {missingRequired.length === 1 ? "var" : "vars"} not set.
                  Preview may fail to start. Launch anyway at your own risk.
                </div>
              </div>
            </div>
          )}

          {/* Thin red divider */}
          <div className="mb-8" style={{ height: 1, background: "rgba(204,34,34,0.15)" }} />

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onBack}
              className="flex-none px-6 py-3.5 font-mono text-[11px] tracking-[0.14em] uppercase transition-colors"
              style={{
                background: "transparent",
                color: "#2e2e2e",
                border: "1px solid #1a1a1a",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#2a2a2a")}
              onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1a1a1a")}
            >
              ← Back
            </button>

            <button
              onClick={handleLaunch}
              disabled={launching || isBlocked}
              className="flex-1 py-3.5 font-mono text-[12px] font-bold tracking-[0.18em] uppercase transition-all"
              style={{
                background: launching || isBlocked ? "#1a0a0a" : "#cc2222",
                color: launching || isBlocked ? "#441111" : "#f0f0f0",
                border: `1px solid ${launching || isBlocked ? "#2a0a0a" : "transparent"}`,
                cursor: launching || isBlocked ? "not-allowed" : "pointer",
              }}
              onMouseEnter={(e) => { if (!launching && !isBlocked) e.currentTarget.style.background = "#e02828"; }}
              onMouseLeave={(e) => { if (!launching && !isBlocked) e.currentTarget.style.background = "#cc2222"; }}
            >
              {launching ? "Booting Preview…" : isBlocked ? "Launch Blocked" : "Launch Preview"}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
