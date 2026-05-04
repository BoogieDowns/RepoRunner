import { useState } from "react";
import { Toaster } from "@/components/ui/toaster";
import { installMock } from "@/mock/repoRunnerMock";
import { AppPhase, RunPlan } from "@/types";
import { LandingScreen } from "@/components/LandingScreen";
import { ScanScreen } from "@/components/ScanScreen";
import { AnalysisScreen } from "@/components/AnalysisScreen";
import { RunningScreen } from "@/components/RunningScreen";

if (typeof window !== "undefined" && !window.repoRunner) {
  installMock();
}

export default function App() {
  const [phase, setPhase] = useState<AppPhase>("landing");
  const [repoUrl, setRepoUrl] = useState("");
  const [runPlan, setRunPlan] = useState<RunPlan | null>(null);

  return (
    <div className="min-h-screen w-full bg-background text-foreground font-sans">
      {phase === "landing" && (
        <LandingScreen
          onAnalyze={(url) => { setRepoUrl(url); setPhase("scanning"); }}
        />
      )}
      {phase === "scanning" && (
        <ScanScreen
          repoUrl={repoUrl}
          onComplete={(plan) => { setRunPlan(plan); setPhase("analysis"); }}
        />
      )}
      {phase === "analysis" && runPlan && (
        <AnalysisScreen
          plan={runPlan}
          onLaunch={() => setPhase("running")}
          onBack={() => setPhase("landing")}
        />
      )}
      {phase === "running" && runPlan && (
        <RunningScreen
          plan={runPlan}
          onStop={() => setPhase("landing")}
        />
      )}
      <Toaster />
    </div>
  );
}
