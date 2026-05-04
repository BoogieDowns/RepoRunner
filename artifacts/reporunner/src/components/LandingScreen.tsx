import { useState, useRef } from "react";
import { TopBar } from "./TopBar";

interface LandingScreenProps {
  onAnalyze: (url: string) => void;
}

export function LandingScreen({ onAnalyze }: LandingScreenProps) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = () => {
    const trimmed = url.trim();
    if (!trimmed) {
      setError("Paste a GitHub repository URL to continue.");
      inputRef.current?.focus();
      return;
    }
    if (!trimmed.includes("github.com") && !trimmed.startsWith("https://")) {
      setError("Enter a valid GitHub URL (e.g. https://github.com/org/repo)");
      return;
    }
    setError("");
    onAnalyze(trimmed);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSubmit();
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#080808" }}>
      <TopBar phase="landing" />

      {/* Scan beam — ambient atmospheric element */}
      <div
        className="pointer-events-none fixed left-0 right-0 animate-scan-beam"
        style={{
          height: 1,
          background: "linear-gradient(90deg, transparent 0%, rgba(204,34,34,0.5) 20%, rgba(204,34,34,0.7) 50%, rgba(204,34,34,0.5) 80%, transparent 100%)",
          top: 0,
          zIndex: 100,
        }}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pt-8">
        <div className="w-full max-w-2xl">

          {/* Red top accent line */}
          <div
            className="mb-16"
            style={{
              height: 1,
              background: "linear-gradient(90deg, transparent, rgba(204,34,34,0.35) 30%, rgba(204,34,34,0.6) 50%, rgba(204,34,34,0.35) 70%, transparent)",
            }}
          />

          {/* Headline */}
          <div className="mb-8">
            <div
              className="font-mono font-bold leading-none tracking-tight mb-3"
              style={{ fontSize: "clamp(2.4rem, 6vw, 4rem)", color: "#d0d0d0", letterSpacing: "-0.02em" }}
            >
              WAKE A REPO.
            </div>
            <div
              className="font-mono font-bold leading-none tracking-tight"
              style={{ fontSize: "clamp(2.4rem, 6vw, 4rem)", color: "#3a3a3a", letterSpacing: "-0.02em" }}
            >
              NO LOCAL SETUP.
            </div>
          </div>

          {/* Subtext */}
          <p
            className="mb-12 leading-relaxed max-w-lg"
            style={{ color: "#4a4a4a", fontSize: "14px", fontFamily: "'Plus Jakarta Sans', sans-serif" }}
          >
            Paste a GitHub repository. Repo Runner scans the stack, maps the missing
            requirements, and boots a browser preview — without touching a terminal.
          </p>

          {/* URL input block */}
          <div className="mb-4">
            <div
              className="relative flex items-center"
              style={{
                background: "#0d0d0d",
                border: `1px solid ${error ? "rgba(204,34,34,0.5)" : "rgba(255,255,255,0.07)"}`,
                transition: "border-color 0.15s",
              }}
            >
              {/* Prompt indicator */}
              <span
                className="font-mono text-[12px] pl-4 pr-2 flex-none"
                style={{ color: "#cc2222" }}
              >
                ›
              </span>

              <input
                ref={inputRef}
                type="url"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setError(""); }}
                onKeyDown={handleKey}
                placeholder="https://github.com/username/repository"
                className="flex-1 bg-transparent outline-none py-4 pr-4 font-mono text-[13px]"
                style={{
                  color: "#c0c0c0",
                  caretColor: "#cc2222",
                }}
                autoFocus
              />

              {/* Cursor blink when empty */}
              {!url && (
                <span
                  className="animate-cursor-blink font-mono text-[13px] absolute pointer-events-none"
                  style={{ color: "#cc2222", left: "calc(1rem + 16px)" }}
                />
              )}
            </div>

            {error && (
              <p className="mt-2 font-mono text-[11px] tracking-wide" style={{ color: "#cc2222" }}>
                ⚠ {error}
              </p>
            )}
          </div>

          {/* Analyze button */}
          <button
            onClick={handleSubmit}
            className="w-full py-4 font-mono text-[12px] font-bold tracking-[0.18em] uppercase transition-all duration-150"
            style={{
              background: "#cc2222",
              color: "#f0f0f0",
              border: "none",
              cursor: "pointer",
              letterSpacing: "0.18em",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#e02828")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "#cc2222")}
            onMouseDown={(e) => (e.currentTarget.style.background = "#aa1a1a")}
            onMouseUp={(e) => (e.currentTarget.style.background = "#e02828")}
          >
            Analyze Repo
          </button>

          {/* Helper text */}
          <div className="mt-5 flex items-center gap-3">
            {["GitHub URL", "Branch detect", "Runtime scan", "Env map"].map((label, i) => (
              <span key={label} className="flex items-center gap-3">
                <span className="font-mono text-[10px] tracking-[0.1em] uppercase" style={{ color: "#2a2a2a" }}>
                  {label}
                </span>
                {i < 3 && <span style={{ color: "#1e1e1e", fontSize: "10px" }}>·</span>}
              </span>
            ))}
          </div>

          {/* Bottom thin line */}
          <div
            className="mt-20"
            style={{
              height: 1,
              background: "linear-gradient(90deg, rgba(204,34,34,0.12), transparent)",
            }}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex-none h-12 flex items-center justify-center">
        <span className="font-mono text-[9px] tracking-[0.14em] uppercase" style={{ color: "#1c1c1c" }}>
          Repo Runner · V0 · Preview Mode
        </span>
      </div>
    </div>
  );
}
