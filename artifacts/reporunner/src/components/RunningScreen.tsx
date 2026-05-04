import { useState, useEffect, useRef } from "react";
import { LogEntry, RunPlan } from "@/types";
import { TopBar } from "./TopBar";

interface RunningScreenProps {
  plan: RunPlan;
  onStop: () => void;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function logColor(entry: LogEntry): string {
  if (entry.level === "error")   return "#cc4444";
  if (entry.level === "warn")    return "#996633";
  switch (entry.source) {
    case "git":      return "#446688";
    case "install":  return "#cc6622";
    case "frontend": return "#447755";
    case "backend":  return "#335577";
    case "system":
    default:         return "#333333";
  }
}

export function RunningScreen({ plan, onStop }: RunningScreenProps) {
  const [logs, setLogs]   = useState<LogEntry[]>([]);
  const [uptime, setUptime] = useState(0);
  const [stopping, setStopping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const startTime = useRef(Date.now());

  useEffect(() => {
    const unsub = window.repoRunner.onLog((entry) => {
      setLogs((prev) => [...prev, entry]);
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  useEffect(() => {
    const interval = setInterval(() => {
      setUptime((Date.now() - startTime.current) / 1000);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleStop = async () => {
    setStopping(true);
    await window.repoRunner.stopPreview();
    onStop();
  };

  const handleOpenPreview = () => {
    window.open(`http://localhost:${plan.port}`, "_blank");
  };

  const handleRestart = async () => {
    await window.repoRunner.stopPreview();
    await window.repoRunner.launchPreview();
    startTime.current = Date.now();
  };

  const handleCopyLogs = async () => {
    await window.repoRunner.copyLogs();
  };

  const handleClearLogs = () => {
    window.repoRunner.clearLogs();
    setLogs([]);
  };

  return (
    <div className="h-screen flex flex-col" style={{ background: "#080808" }}>
      <TopBar phase="running" />

      {/* Status bar */}
      <div
        className="flex-none pt-8 px-6 pb-0"
      >
        <div className="max-w-5xl mx-auto">
          <div
            className="flex items-center justify-between py-4 px-5 mt-2"
            style={{ background: "#0a0a0a", border: "1px solid rgba(255,255,255,0.05)" }}
          >
            {/* Preview online indicator */}
            <div className="flex items-center gap-3">
              <span
                className="animate-pulse-dot"
                style={{
                  display: "inline-block", width: 7, height: 7,
                  borderRadius: "50%", background: "#cc2222",
                  boxShadow: "0 0 8px #cc2222",
                }}
              />
              <span className="font-mono text-[11px] tracking-[0.14em] uppercase" style={{ color: "#cc5555" }}>
                Preview Online
              </span>
              <span className="font-mono text-[10px]" style={{ color: "#222" }}>·</span>
              <span className="font-mono text-[11px]" style={{ color: "#444" }}>
                {plan.projectName}
              </span>
            </div>

            {/* Uptime */}
            <span className="font-mono text-[10px] tracking-wide" style={{ color: "#2a2a2a" }}>
              {formatUptime(uptime)}
            </span>
          </div>
        </div>
      </div>

      {/* Info + logs */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="h-full max-w-5xl mx-auto px-6 py-4 flex gap-4">

          {/* Info panels — left column */}
          <div className="w-52 flex-none flex flex-col gap-0">
            <div className="font-mono text-[9px] tracking-[0.18em] uppercase mb-3" style={{ color: "#1e1e1e" }}>
              System State
            </div>
            {[
              { label: "Framework", value: plan.framework },
              { label: "Runtime",   value: plan.runtime },
              { label: "Port",      value: String(plan.port) },
              { label: "Branch",    value: plan.branch },
              { label: "URL",       value: `localhost:${plan.port}` },
            ].map((item) => (
              <div
                key={item.label}
                className="py-2.5"
                style={{ borderBottom: "1px solid rgba(255,255,255,0.03)" }}
              >
                <div className="font-mono text-[9px] tracking-[0.1em] uppercase mb-0.5" style={{ color: "#222" }}>
                  {item.label}
                </div>
                <div className="font-mono text-[11px]" style={{ color: "#555" }}>
                  {item.value}
                </div>
              </div>
            ))}

            {/* Actions */}
            <div className="mt-auto pt-6 flex flex-col gap-2">
              <button
                onClick={handleOpenPreview}
                className="w-full py-2.5 font-mono text-[10px] tracking-[0.14em] uppercase"
                style={{ background: "#cc2222", color: "#f0f0f0", border: "none", cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#e02828")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#cc2222")}
              >
                Open Preview
              </button>
              <button
                onClick={handleRestart}
                className="w-full py-2.5 font-mono text-[10px] tracking-[0.14em] uppercase"
                style={{ background: "transparent", color: "#2e2e2e", border: "1px solid #1a1a1a", cursor: "pointer" }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#333")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#1a1a1a")}
              >
                Restart
              </button>
              <button
                onClick={handleStop}
                disabled={stopping}
                className="w-full py-2.5 font-mono text-[10px] tracking-[0.14em] uppercase"
                style={{
                  background: "transparent",
                  color: stopping ? "#222" : "#441111",
                  border: `1px solid ${stopping ? "#1a1a1a" : "rgba(204,34,34,0.2)"}`,
                  cursor: stopping ? "not-allowed" : "pointer",
                }}
              >
                {stopping ? "Stopping…" : "Stop"}
              </button>
            </div>
          </div>

          {/* Logs — right column */}
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex-none flex items-center justify-between mb-2">
              <div className="flex items-center gap-3">
                <span className="font-mono text-[9px] tracking-[0.18em] uppercase" style={{ color: "#1e1e1e" }}>
                  Log Stream
                </span>
                <span
                  className="font-mono text-[9px] px-1.5 py-[2px]"
                  style={{ color: "#222", border: "1px solid #181818" }}
                >
                  {logs.length}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={handleCopyLogs}
                  className="font-mono text-[9px] tracking-[0.1em] uppercase"
                  style={{ color: "#1e1e1e", background: "none", border: "none", cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#333")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#1e1e1e")}
                >
                  Copy
                </button>
                <button
                  onClick={handleClearLogs}
                  className="font-mono text-[9px] tracking-[0.1em] uppercase"
                  style={{ color: "#1e1e1e", background: "none", border: "none", cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#333")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#1e1e1e")}
                >
                  Clear
                </button>
              </div>
            </div>

            <div
              ref={scrollRef}
              className="flex-1 min-h-0 overflow-y-auto p-4"
              style={{ background: "#050505", border: "1px solid rgba(255,255,255,0.04)" }}
            >
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center">
                  <span className="font-mono text-[11px] italic" style={{ color: "#1e1e1e" }}>
                    Waiting for output…
                  </span>
                </div>
              ) : (
                <div className="space-y-0">
                  {logs.map((log) => (
                    <div
                      key={log.id}
                      className="flex gap-3 py-[3px] px-1 hover:bg-white/[0.015] rounded-none"
                    >
                      <span
                        className="flex-none font-mono text-[10px] tabular-nums"
                        style={{ color: "#1e1e1e", width: 52, textAlign: "right" }}
                      >
                        {new Date(log.timestamp).toLocaleTimeString([], {
                          hour12: false,
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                      <span
                        className="flex-none font-mono text-[9px] tracking-[0.1em] uppercase"
                        style={{ color: logColor(log), width: 60 }}
                      >
                        [{log.source}]
                      </span>
                      <span
                        className="font-mono text-[11px] whitespace-pre-wrap break-all"
                        style={{ color: log.level === "error" ? "#883333" : "#404040" }}
                      >
                        {log.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
