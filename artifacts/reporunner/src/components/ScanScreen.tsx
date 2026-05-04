import { useEffect, useRef, useState } from "react";
import { RunPlan, ScanStep } from "@/types";
import { TopBar } from "./TopBar";

const STEP_DEFS = [
  { id: "clone",     label: "CLONING REPOSITORY" },
  { id: "packages",  label: "READING PACKAGE FILES" },
  { id: "framework", label: "DETECTING FRAMEWORK" },
  { id: "command",   label: "IDENTIFYING START COMMAND" },
  { id: "env",       label: "SCANNING ENVIRONMENT VARIABLES" },
  { id: "plan",      label: "BUILDING RUN PLAN" },
];

interface ScanScreenProps {
  repoUrl: string;
  onComplete: (plan: RunPlan) => void;
}

export function ScanScreen({ repoUrl, onComplete }: ScanScreenProps) {
  const [steps, setSteps] = useState<ScanStep[]>(
    STEP_DEFS.map((s) => ({ ...s, status: "pending" }))
  );
  const [elapsed, setElapsed] = useState(0);
  const startedRef = useRef(false);

  // Elapsed timer
  useEffect(() => {
    const interval = setInterval(() => setElapsed((s) => s + 0.1), 100);
    return () => clearInterval(interval);
  }, []);

  // Drive analysis
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    window.repoRunner.analyzeRepo(repoUrl, (updatedStep) => {
      setSteps((prev) =>
        prev.map((s) => (s.id === updatedStep.id ? { ...s, status: updatedStep.status } : s))
      );
    }).then((plan) => {
      // Brief pause so user sees all steps done before transition
      setTimeout(() => onComplete(plan), 600);
    });
  }, [repoUrl, onComplete]);

  const activeIndex = steps.findIndex((s) => s.status === "active");

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#080808" }}>
      <TopBar phase="scanning" />

      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-8">
        <div className="w-full max-w-xl">

          {/* Section header */}
          <div className="mb-10">
            <div
              className="font-mono text-[10px] tracking-[0.2em] uppercase mb-3"
              style={{ color: "#2a2a2a" }}
            >
              ── System Analysis
            </div>
            <div
              className="font-mono text-[11px] tracking-[0.1em] truncate"
              style={{ color: "#333" }}
            >
              {repoUrl}
            </div>
          </div>

          {/* Thin red divider */}
          <div className="mb-8" style={{ height: 1, background: "rgba(204,34,34,0.2)" }} />

          {/* Scan steps */}
          <div className="flex flex-col gap-0">
            {steps.map((step, i) => {
              const isDone    = step.status === "done";
              const isActive  = step.status === "active";
              const isPending = step.status === "pending";

              return (
                <div
                  key={step.id}
                  className="flex items-center gap-5 py-3"
                  style={{
                    borderBottom: "1px solid rgba(255,255,255,0.03)",
                    animation: isDone ? "step-appear 0.2s ease-out" : undefined,
                  }}
                >
                  {/* Step number */}
                  <span
                    className="font-mono text-[10px] w-4 text-right flex-none"
                    style={{ color: isDone ? "#333" : isActive ? "#993333" : "#1c1c1c" }}
                  >
                    {String(i + 1).padStart(2, "0")}
                  </span>

                  {/* Status indicator */}
                  <span className="flex-none w-4 flex items-center justify-center">
                    {isDone && (
                      <span className="font-mono text-[11px]" style={{ color: "#3a3a3a" }}>✓</span>
                    )}
                    {isActive && (
                      <span className="animate-pulse-dot" style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#cc2222", boxShadow: "0 0 6px #cc2222" }} />
                    )}
                    {isPending && (
                      <span style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "#1a1a1a" }} />
                    )}
                  </span>

                  {/* Label */}
                  <span
                    className="font-mono text-[11px] tracking-[0.1em] flex-1"
                    style={{
                      color: isDone ? "#2e2e2e" : isActive ? "#cc6666" : "#1e1e1e",
                      letterSpacing: "0.1em",
                    }}
                  >
                    {step.label}
                  </span>

                  {/* Active scanning dots */}
                  {isActive && (
                    <span className="font-mono text-[11px]" style={{ color: "#441111" }}>
                      <span className="animate-cursor-blink">█</span>
                    </span>
                  )}

                  {/* Done tag */}
                  {isDone && (
                    <span
                      className="font-mono text-[9px] tracking-[0.1em] uppercase flex-none"
                      style={{ color: "#222" }}
                    >
                      DONE
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Elapsed */}
          <div className="mt-8 flex items-center justify-between">
            <span className="font-mono text-[10px]" style={{ color: "#1e1e1e" }}>
              ELAPSED
            </span>
            <span className="font-mono text-[10px]" style={{ color: "#2a2a2a" }}>
              {elapsed.toFixed(1)}s
            </span>
          </div>

        </div>
      </div>
    </div>
  );
}
