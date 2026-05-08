import { useState, useEffect, useRef, useCallback } from "react";
import {
  Download,
  Package,
  Play,
  Server,
  SquareSquare,
  RotateCw,
  ExternalLink,
  Copy,
  Trash2,
  Settings2,
  Loader2,
} from "lucide-react";
import { ProjectProfile, ServiceStatuses, LogEntry } from "@/types";
import { CommandButton } from "./CommandButton";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

/* ─── Damped sine-wave path for the divider ripple ───────────────────────────
 * Pre-computed once at module load. The wave is a dampened cosine centered at
 * the impact point (x=0 in screen space, mapped to x=320 in SVG space).
 *
 * Formula:  svgY = 12 + A·cos(ω·x)·exp(−|x|/τ)
 *   A = 5.5 px — visible amplitude without being cartoonish
 *   ω = 0.052  — ~5 full oscillations across the ±320 px span
 *   τ = 58 px  — fast envelope decay so the wave dies off past ~150 px
 *
 * The SVG element is 640 × 24 px, centered on the impact x-position.
 * y=12 aligns with the physical divider line so undisturbed tails sit on it.
 */
const WAVE_PATH = (() => {
  // Compact wave packet: span ±110 px (220 px total), amplitude 7 px, decay τ=32 px
  const A = 7, omega = 0.055, tau = 32;
  const pts: string[] = [];
  for (let x = -110; x <= 110; x += 2) {
    const env = Math.exp(-Math.abs(x) / tau);
    const y   = 12 + A * Math.cos(omega * x) * env;
    pts.push(`${x === -110 ? "M" : "L"}${(x + 110).toFixed(1)},${y.toFixed(2)}`);
  }
  return pts.join(" ");
})();

/* ─── Ambient Background ──────────────────────────────────────────────────── */

interface MeteorDef {
  id:    number;
  left:  number;       // % from left edge
  dur:   number;       // fall duration (seconds)
  h:     number;       // streak height (vh)
  op:    number;       // base opacity
  layer: 0 | 1 | 2;   // 0 = background, 1 = midground, 2 = foreground
}

interface RippleDef {
  id:       number;
  left:     number;    // % from left edge
  dividerY: number;    // px from top of viewport (= container top since inset:0)
  op:       number;    // opacity scalar
}


/**
 * A single meteor streak.
 * Spawns at top: -70vh (above viewport), plays one full fall, then calls onDone.
 * The parent removes it from state — no orphan elements.
 *
 * Layer visual behaviour:
 *   0 bg  — 1px wide, short head, no glow, slow, dim   → quiet atmospheric depth
 *   1 mid — 2px wide, standard head, soft glow          → main mid-field layer
 *   2 fg  — 3px wide, tall head, strong glow, fast       → vivid foreground presence
 */
function MeteorLine({ id, left, dur, h, op, layer, onDone }: MeteorDef & { onDone: (id: number) => void }) {
  const cW      = layer === 0 ? 1 : layer === 1 ? 2 : 3;   // streak container width px
  const headH   = layer === 0 ? 4 : layer === 1 ? 11 : 18; // head height px
  const glowPx  = layer === 0 ? 0 : layer === 1 ? 5 : 10;  // glow blur radius
  const glowSpr = layer === 0 ? 0 : layer === 1 ? 1 : 2;   // glow spread radius
  const glowMul = layer === 0 ? 0 : layer === 1 ? 0.30 : 0.58; // opacity multiplier
  const tailOff = cW > 1 ? Math.floor(cW / 2) : 0;         // center 1px tail in container

  return (
    <div
      style={{
        position: "absolute",
        top: "-70vh",
        left: `${left}%`,
        width: `${cW}px`,
        height: `${h}vh`,
        transform: "translateX(-50%)",
        animationName: "rr-fall",
        animationDuration: `${dur}s`,
        animationTimingFunction: "linear",
        animationIterationCount: 1,
        animationFillMode: "forwards",
      }}
      onAnimationEnd={() => onDone(id)}
    >
      {/* Tail — fades in gradually from top, brightens toward head */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: `${tailOff}px`,
          width: "1px",
          height: "100%",
          background: `linear-gradient(to bottom,
            transparent 0%,
            rgba(140,10,10,${op * 0.03}) 10%,
            rgba(158,14,14,${op * 0.12}) 32%,
            rgba(188,24,24,${op * 0.34}) 58%,
            rgba(210,38,38,${op * 0.64}) 80%,
            rgba(224,45,45,${op * 0.88}) 100%
          )`,
        }}
      />
      {/* Head — bright leading point, scaled by layer */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: "0px",
          width: `${cW}px`,
          height: `${headH}px`,
          background: `linear-gradient(to bottom,
            rgba(210,40,40,${op * 0.80}),
            rgba(255,82,82,${op * 0.97}),
            rgba(255,115,115,${op * 0.50})
          )`,
          boxShadow: glowMul > 0
            ? `0 0 ${glowPx}px ${glowSpr}px rgba(255,72,72,${op * glowMul})`
            : "none",
          borderRadius: "1px 1px 2px 2px",
        }}
      />
    </div>
  );
}

function AmbientBackground({
  anyRunning,
  bothRunning,
  dividerRef,
}: {
  anyRunning:  boolean;
  bothRunning: boolean;
  dividerRef:  React.RefObject<HTMLElement | null>;
}) {
  const [meteors,   setMeteors]   = useState<MeteorDef[]>([]);
  const [ripples,   setRipples]   = useState<RippleDef[]>([]);
  const spawnerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const idRef          = useRef(0);
  const wasRunningRef  = useRef(false);
  /* Refs so the visibilitychange handler always reads the current prop values */
  const anyRunningRef  = useRef(anyRunning);
  const bothRunningRef = useRef(bothRunning);
  anyRunningRef.current  = anyRunning;
  bothRunningRef.current = bothRunning;

  /* Stable callback: removes one meteor by id after its animation ends */
  const removeMeteor = useCallback((id: number) => {
    setMeteors(prev => prev.filter(m => m.id !== id));
  }, []);

  /*
   * Trigger a divider impact: a brief horizontal ripple on the line + a handful
   * of tiny pixel fragments that drift down into the terminal zone.
   * Only fired for mid (layer=1) and fg (layer=2) meteors.
   */
  const triggerImpactRef = useRef<(left: number, op: number, layer: 1 | 2, dividerY: number) => void>(() => {});
  const triggerImpact = useCallback((left: number, op: number, layer: 1 | 2, dividerY: number) => {
    /* Wave ripple — keep alive for the full wave animation duration */
    const rippleId = ++idRef.current;
    setRipples(prev => [...prev, { id: rippleId, left, dividerY, op }]);
    setTimeout(() => setRipples(prev => prev.filter(r => r.id !== rippleId)), 1300);

  }, []);
  triggerImpactRef.current = triggerImpact;

  /* Stable callback: creates one new meteor with randomised properties.
   * Layer distribution: 35% background, 45% midground, 20% foreground.
   * Each layer gets its own speed/size/opacity ranges so they read as
   * genuinely different depth planes rather than uniform random variation.
   *
   * For mid/fg meteors, schedules a divider impact (ripple + fragments)
   * at the moment the meteor head crosses the log-panel border line. */
  const spawnMeteor = useCallback(() => {
    /* Compute all values outside the state updater to avoid side-effects
     * (React may call updaters more than once in StrictMode). */
    const id   = ++idRef.current;
    const left = 5 + Math.random() * 87;   // 5–92 %
    const rand = Math.random();
    const layer: 0 | 1 | 2 = rand < 0.35 ? 0 : rand < 0.80 ? 1 : 2;
    // bg: slow + short + dim | mid: current | fg: fast + tall + bright
    const dur = layer === 0 ? 9.5 + Math.random() * 5.0   // 9.5–14.5 s
              : layer === 2 ? 4.2 + Math.random() * 2.6   // 4.2–6.8 s
              :               6.2 + Math.random() * 3.4;  // 6.2–9.6 s
    const h   = layer === 0 ? 14  + Math.random() * 18    // 14–32 vh
              : layer === 2 ? 46  + Math.random() * 30    // 46–76 vh
              :               32  + Math.random() * 26;   // 32–58 vh
    const op  = layer === 0 ? 0.09 + Math.random() * 0.15 // 0.09–0.24
              : layer === 2 ? 0.54 + Math.random() * 0.30 // 0.54–0.84
              :               0.28 + Math.random() * 0.34; // 0.28–0.62

    setMeteors(prev => [...prev, { id, left, dur, h, op, layer }]);

    /* Schedule divider impact for mid/fg meteors only.
     * rr-fall: element top starts at -70vh, translates +175vh over dur seconds.
     * Meteor head (bottom of element) at time t: y(t) = -70 + h + (t/dur)*175  vh.
     * Solve for y(t) = dividerVh: tImpact = (dividerVh + 70 − h) * dur / 175. */
    if (layer >= 1 && dividerRef.current) {
      const dividerVh = dividerRef.current.getBoundingClientRect().top / window.innerHeight * 100;
      const tImpact   = (dividerVh + 70 - h) * dur / 175;
      if (tImpact > 0.05 && tImpact < dur) {
        setTimeout(() => {
          const liveY = dividerRef.current?.getBoundingClientRect().top ?? -1;
          if (liveY > 0) triggerImpactRef.current(left, op, layer as 1 | 2, liveY);
        }, tImpact * 1000);
      }
    }
  }, [dividerRef]);

  useEffect(() => {
    /* Clear any running spawner before reconfiguring */
    if (spawnerRef.current) { clearInterval(spawnerRef.current); spawnerRef.current = null; }

    if (anyRunning) {
      /* Initial burst — only on first activation, not on density change */
      if (!wasRunningRef.current) {
        const count = bothRunning ? 7 : 4;
        for (let i = 0; i < count; i++) setTimeout(spawnMeteor, i * 300);
      }
      wasRunningRef.current = true;

      /* Ongoing stream: sparser for 1 service, slightly denser for 2 */
      const interval = bothRunning ? 1050 : 1700;
      spawnerRef.current = setInterval(spawnMeteor, interval);
    } else {
      wasRunningRef.current = false;
      /* No spawner — existing meteors self-remove via onAnimationEnd / removeMeteor */
    }

    return () => { if (spawnerRef.current) { clearInterval(spawnerRef.current); spawnerRef.current = null; } };
  }, [anyRunning, bothRunning, spawnMeteor]);

  /* Pause spawning while the tab/window is hidden; restart cleanly on return.
   * Clearing the interval on hide means no timer debt accumulates, so there
   * is no burst of catch-up meteors when the user switches back. */
  useEffect(() => {
    const handleVisibility = () => {
      if (document.hidden) {
        /* Tab hidden — kill spawner so no timers pile up in the background */
        if (spawnerRef.current) { clearInterval(spawnerRef.current); spawnerRef.current = null; }
      } else {
        /* Tab visible again — restart fresh only if services are still running */
        if (anyRunningRef.current && !spawnerRef.current) {
          const interval = bothRunningRef.current ? 1600 : 2600;
          spawnerRef.current = setInterval(spawnMeteor, interval);
        }
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [spawnMeteor]);

  const moonBorder = anyRunning
    ? bothRunning ? "rgba(175,25,25,0.20)" : "rgba(155,20,20,0.13)"
    : "rgba(90,8,8,0.06)";
  const moonGlow = anyRunning
    ? bothRunning
      ? "0 0 60px rgba(175,25,25,0.18), 0 0 120px rgba(130,12,12,0.10)"
      : "0 0 40px rgba(155,20,20,0.11)"
    : "none";

  const grainUrl = `url('data:image/svg+xml,<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="4" stitchTiles="stitch"/></filter><rect width="100%25" height="100%25" filter="url(%23n)"/></svg>')`;

  return (
    <>
    {/* ── Masked atmospheric layer: meteors, grain, moon ────────────────────
        This mask fades content toward the bottom. Ripples/fragments must NOT
        live here — they sit at the divider which is in the masked-out zone. */}
    <div
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
        WebkitMaskImage: "linear-gradient(to bottom, black 0%, black 46%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.06) 100%)",
        maskImage:        "linear-gradient(to bottom, black 0%, black 46%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.18) 84%, rgba(0,0,0,0.06) 100%)",
      }}
    >
      {/* Film grain */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage: grainUrl,
          backgroundSize: "200px 200px",
          opacity: 0.048,
          mixBlendMode: "overlay",
        }}
      />

      {/* Outer halo ring */}
      <div
        style={{
          position: "absolute",
          bottom: "-315px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "790px",
          height: "790px",
          borderRadius: "50%",
          border: `1px solid ${anyRunning ? "rgba(130,12,12,0.07)" : "rgba(70,5,5,0.04)"}`,
          transition: "border-color 2.5s ease",
        }}
      />

      {/* Main moon arc */}
      <div
        style={{
          position: "absolute",
          bottom: "-265px",
          left: "50%",
          transform: "translateX(-50%)",
          width: "650px",
          height: "650px",
          borderRadius: "50%",
          border: `1px solid ${moonBorder}`,
          boxShadow: moonGlow,
          transition: "border-color 2.5s ease, box-shadow 2.5s ease",
        }}
      />

      {/* Dynamic meteors — each spawns above viewport, falls once, self-removes */}
      {meteors.map(m => (
        <MeteorLine key={m.id} {...m} onDone={removeMeteor} />
      ))}
    </div>

    {/* ── Unmasked impact layer ───────────────────────────────────────────────
        Ripples and fragments MUST live outside the masked container above.
        The mask fades to ~0.06 opacity at the divider position, which would
        make them invisible. This sibling div has no mask applied. */}
    <div
      aria-hidden="true"
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none", zIndex: 0 }}
    >
      {/* Impact ripples — SVG dampened-sine wave + circular contact flash */}
      {ripples.flatMap(r => [
        /*
         * 1. SVG wave — the divider line itself deforming outward from the hit.
         *    Two strokes stacked: wide dim outer (glow) + narrow bright inner (core).
         *    clip-path expands symmetrically from center via rr-wave-expand keyframe.
         *    Position: top = dividerY - 12 so y=12 in SVG space sits on the line.
         */
        <svg
          key={`wave-${r.id}`}
          aria-hidden="true"
          width="220"
          height="24"
          viewBox="0 0 220 24"
          style={{
            position:  "absolute",
            top:       `${r.dividerY - 12}px`,
            left:      `${r.left}%`,
            transform: "translateX(-50%)",
            overflow:  "hidden",
            pointerEvents: "none",
            filter:    `drop-shadow(0 0 3px rgba(210,44,44,${r.op * 0.42}))`,
            WebkitMaskImage: "radial-gradient(ellipse 80% 200% at 50% 50%, black 20%, rgba(0,0,0,0.40) 55%, transparent 85%)",
            maskImage:        "radial-gradient(ellipse 80% 200% at 50% 50%, black 20%, rgba(0,0,0,0.40) 55%, transparent 85%)",
            animationName:        "rr-wave-expand",
            animationDuration:    "0.80s",
            animationTimingFunction: "ease-out",
            animationFillMode:    "forwards",
          }}
        >
          {/* Soft outer glow */}
          <path
            d={WAVE_PATH}
            fill="none"
            stroke={`rgba(204,40,40,${r.op * 0.28})`}
            strokeWidth="5"
            strokeLinecap="round"
          />
          {/* Core line */}
          <path
            d={WAVE_PATH}
            fill="none"
            stroke={`rgba(240,64,64,${r.op * 0.65})`}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>,

        /*
         * 2. Contact flash — a circular energy bloom at the exact impact point.
         *    Appears at t=0, expands and fades via rr-flash-burst keyframe.
         *    Centered vertically on the divider line (top = dividerY - 4 for 8px element).
         */
        <div
          key={`flash-${r.id}`}
          style={{
            position:     "absolute",
            top:          `${r.dividerY - 4}px`,
            left:         `${r.left}%`,
            width:        "8px",
            height:       "8px",
            borderRadius: "50%",
            transform:    "translateX(-50%)",
            background:   `rgba(255,190,190,${r.op * 0.55})`,
            boxShadow: [
              `0 0  3px 1px rgba(255, 80, 80,${r.op * 0.48})`,
              `0 0  7px 2px rgba(210, 44, 44,${r.op * 0.30})`,
              `0 0 13px 4px rgba(170, 24, 24,${r.op * 0.14})`,
            ].join(", "),
            pointerEvents:   "none",
            animationName:        "rr-flash-burst",
            animationDuration:    "0.09s",
            animationTimingFunction: "ease-out",
            animationFillMode:    "forwards",
          }}
        />,
      ])}

    </div>
    </>
  );
}

/* ─── Logo ──────────────────────────────────────────────────────────────────*/

function RepoRunnerLogo() {
  return (
    <svg
      width="32"
      height="32"
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      style={{ filter: "drop-shadow(0 0 7px rgba(204,30,30,0.48))", flexShrink: 0 }}
    >
      <defs>
        <linearGradient id="rr-badge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#210e0e" />
          <stop offset="100%" stopColor="#090404" />
        </linearGradient>
        <linearGradient id="rr-border-g" x1="0" y1="0" x2="0" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="rgba(230,55,55,0.70)" />
          <stop offset="55%"  stopColor="rgba(150,20,20,0.35)" />
          <stop offset="100%" stopColor="rgba(60,8,8,0.15)" />
        </linearGradient>
        <linearGradient id="rr-mark-g" x1="0" y1="6" x2="0" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%"   stopColor="#ffaaaa" />
          <stop offset="30%"  stopColor="#e03030" />
          <stop offset="100%" stopColor="#5a0c0c" />
        </linearGradient>
      </defs>

      {/* Badge */}
      <rect width="32" height="32" rx="7" fill="url(#rr-badge)" />
      <rect width="32" height="32" rx="7" fill="none" stroke="url(#rr-border-g)" strokeWidth="1" />
      {/* Top-edge gloss */}
      <rect x="1.5" y="1.5" width="29" height="5.5" rx="5" fill="rgba(255,255,255,0.032)" />

      {/*
        R Я monogram — each letter has its own outer stem.
        Left R:  stem on the left  (x=6),  bowl opens rightward, leg angles to center-bottom.
        Right Я: stem on the right (x=26), bowl opens leftward,  leg angles to center-bottom.
        Both legs converge at (16, 26) — forming one unified diamond silhouette.
      */}
      <path
        d={[
          /* ── Left R ── */
          /* stem */      "M 6 6.5 L 6 25.5",
          /* bowl */      "M 6 6.5 L 12.5 6.5 Q 15 6.5 15 9.5 L 15 14.5 Q 15 17 12.5 17 L 6 17",
          /* leg */       "M 10.5 17 L 16 26",

          /* ── Right Я (mirrored) ── */
          /* stem */      "M 26 6.5 L 26 25.5",
          /* bowl */      "M 26 6.5 L 19.5 6.5 Q 17 6.5 17 9.5 L 17 14.5 Q 17 17 19.5 17 L 26 17",
          /* leg */       "M 21.5 17 L 16 26",
        ].join(" ")}
        stroke="url(#rr-mark-g)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/* ─── Dashboard ─────────────────────────────────────────────────────────────*/

interface DashboardProps {
  project: ProjectProfile;
  onEdit: () => void;
}

const MONO: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const LABEL: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "10px",
  fontWeight: 500,
  letterSpacing: "0.13em",
  textTransform: "uppercase",
};

export function Dashboard({ project, onEdit }: DashboardProps) {
  const { toast } = useToast();
  const [statuses, setStatuses] = useState<ServiceStatuses>({
    frontend: "stopped",
    backend: "stopped",
  });
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const unsubLog = window.repoRunner.onLog((entry) => {
      setLogs((prev) => [...prev, entry]);
    });
    const unsubStatus = window.repoRunner.onStatus((s) => {
      setStatuses(s);
    });
    return () => { unsubLog(); unsubStatus(); };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  const wrapAction = (name: string, fn: () => Promise<void>) => async () => {
    setActionLoading((prev) => ({ ...prev, [name]: true }));
    try {
      await fn();
    } catch (err) {
      toast({
        title: "Action failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setActionLoading((prev) => ({ ...prev, [name]: false }));
    }
  };

  const handleCopyLogs = async () => {
    await window.repoRunner.copyLogs();
    toast({ title: "Copied", description: "Logs copied to clipboard." });
  };

  const handleClearLogs = async () => {
    await window.repoRunner.clearLogs();
    setLogs([]);
  };

  const anyRunning =
    statuses.frontend === "running" || statuses.frontend === "starting" ||
    statuses.backend  === "running" || statuses.backend  === "starting";
  const bothRunning =
    statuses.frontend === "running" && statuses.backend === "running";
  const bothStopped =
    statuses.frontend === "stopped" && statuses.backend === "stopped";

  const getStatusDisplay = (status: string) => {
    /*
      Two-element structure:
        housing  — stable bezel/frame with outer shadow, never animates
        lens     — inner face; running state has pulsing glow via .rr-indicator-running

      Lens layers (back → front):
        1. radial gradient  — internal illumination from a centered light source
        2. angled specular  — upper-left reflection off the plastic face surface
        3. horizontal ribs  — fine 2.5px-pitch grooves molded into the lens face
    */

    /* Housing: identical bezel for every state — square-edged industrial module */
    const housing: React.CSSProperties = {
      display: "inline-flex",
      flexShrink: 0,
      borderRadius: "3px",
      padding: "1.5px",
    };

    /* Lens: text lives here, over the textured plastic face */
    const lens: React.CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: "5px",
      padding: "4px 9px",
      borderRadius: "1px",
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: "10px",
      fontWeight: 600,
      letterSpacing: "0.11em",
      textTransform: "uppercase",
      lineHeight: 1,
      whiteSpace: "nowrap",
      userSelect: "none",
      transition: "box-shadow 0.4s ease-out, background 0.4s ease-out, color 0.4s ease-out",
    };

    /* Fine horizontal lens ribs at 2.5px pitch */
    const ribs = (a: number) =>
      `repeating-linear-gradient(0deg, transparent 0px, transparent 1.5px, rgba(0,0,0,${a}) 1.5px, rgba(0,0,0,${a}) 2.5px)`;

    /* Angled specular — upper-left catch, fades quickly */
    const specular = (r: number, g: number, b: number, peak: number) =>
      `linear-gradient(148deg, rgba(${r},${g},${b},${peak}) 0%, rgba(${r},${g},${b},${peak * 0.38}) 18%, transparent 36%)`;

    switch (status) {
      case "running":
        return (
          <span style={{
            ...housing,
            background: "linear-gradient(180deg, #1e0c0c 0%, #070202 100%)",
            border: "1px solid rgba(60,14,14,0.95)",
            boxShadow: "0 2px 7px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,110,110,0.05), inset 0 -1px 0 rgba(0,0,0,0.40)",
          }}>
            <span
              style={{
                ...lens,
                background: [
                  ribs(0.26),
                  specular(255, 230, 225, 0.28),
                  "radial-gradient(ellipse at 50% 58%, rgba(255,180,164,0.96) 0%, rgba(232,52,52,0.98) 24%, rgba(178,18,18,0.98) 58%, rgba(62,4,4,0.99) 100%)",
                ].join(", "),
                color: "rgba(255,226,222,0.98)",
                textShadow: "0 0 10px rgba(255,95,85,0.92)",
                boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 1px rgba(0,0,0,0.28), inset 1px 0 1px rgba(0,0,0,0.18), inset -1px 0 1px rgba(0,0,0,0.18), 0 0 15px rgba(204,34,34,0.82), 0 0 5px rgba(204,34,34,0.56)",
                animation: "rr-lens-on 1.2s ease-in forwards",
              }}
            >
              Running
            </span>
          </span>
        );

      case "starting":
        return (
          <span style={{
            ...housing,
            background: "linear-gradient(180deg, #1a0e07 0%, #070402 100%)",
            border: "1px solid rgba(52,28,10,0.92)",
            boxShadow: "0 2px 7px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.65)",
          }}>
            <span style={{
              ...lens,
              background: [
                ribs(0.28),
                specular(242, 184, 160, 0.22),
                "radial-gradient(ellipse at 50% 58%, rgba(198,112,72,0.88) 0%, rgba(128,54,22,0.94) 40%, rgba(58,18,6,0.97) 100%)",
              ].join(", "),
              color: "rgba(246,196,174,0.96)",
              textShadow: "0 0 8px rgba(242,184,160,0.62)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 1px rgba(0,0,0,0.28), inset 1px 0 1px rgba(0,0,0,0.18), inset -1px 0 1px rgba(0,0,0,0.18), 0 0 11px rgba(242,184,160,0.52), 0 0 4px rgba(242,184,160,0.32)",
              animation: "rr-lens-on 1.2s ease-in forwards",
            }}>
              <Loader2 className="w-[9px] h-[9px] animate-spin flex-none" />
              Starting
            </span>
          </span>
        );

      case "stopping":
        return (
          <span style={{
            ...housing,
            background: "linear-gradient(180deg, #160c06 0%, #060402 100%)",
            border: "1px solid rgba(44,24,8,0.88)",
            boxShadow: "0 2px 7px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.65)",
          }}>
            <span style={{
              ...lens,
              background: [
                ribs(0.30),
                specular(200, 148, 115, 0.15),
                "radial-gradient(ellipse at 50% 58%, rgba(170,92,56,0.74) 0%, rgba(108,46,17,0.90) 44%, rgba(44,15,5,0.97) 100%)",
              ].join(", "),
              color: "rgba(214,162,130,0.92)",
              textShadow: "0 0 7px rgba(200,148,115,0.48)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 1px rgba(0,0,0,0.28), inset 1px 0 1px rgba(0,0,0,0.18), inset -1px 0 1px rgba(0,0,0,0.18), 0 0 10px rgba(200,148,115,0.44), 0 0 4px rgba(200,148,115,0.28)",
              animation: "rr-lens-on 1.2s ease-in forwards",
            }}>
              <Loader2 className="w-[9px] h-[9px] animate-spin flex-none" />
              Stopping
            </span>
          </span>
        );

      case "failed":
        return (
          <span style={{
            ...housing,
            background: "linear-gradient(180deg, #1e0c0c 0%, #070202 100%)",
            border: "1px solid rgba(60,14,14,0.95)",
            boxShadow: "0 2px 7px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.65), 0 0 8px rgba(224,48,48,0.12)",
          }}>
            <span style={{
              ...lens,
              background: [
                ribs(0.24),
                specular(255, 200, 195, 0.24),
                "radial-gradient(ellipse at 50% 58%, rgba(255,118,112,0.80) 0%, rgba(218,38,38,0.90) 26%, rgba(150,12,12,0.93) 60%, rgba(48,2,2,0.98) 100%)",
              ].join(", "),
              color: "rgba(255,208,204,0.93)",
              textShadow: "0 0 7px rgba(255,95,85,0.62)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 1px rgba(0,0,0,0.28), inset 1px 0 1px rgba(0,0,0,0.18), inset -1px 0 1px rgba(0,0,0,0.18), 0 0 5px rgba(224,48,48,0.28)",
            }}>
              Failed
            </span>
          </span>
        );

      case "unknown":
        return (
          <span style={{
            ...housing,
            background: "linear-gradient(180deg, #111111 0%, #060606 100%)",
            border: "1px solid rgba(34,34,34,0.92)",
            boxShadow: "0 2px 7px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.65)",
          }}>
            <span style={{
              ...lens,
              background: [
                ribs(0.38),
                "linear-gradient(148deg, rgba(68,68,68,0.10) 0%, transparent 34%)",
                "radial-gradient(ellipse at 50% 58%, rgba(35,35,35,0.75) 0%, rgba(15,15,15,0.90) 55%, rgba(5,5,5,0.97) 100%)",
              ].join(", "),
              color: "rgba(74,70,68,0.86)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 1px rgba(0,0,0,0.28), inset 1px 0 1px rgba(0,0,0,0.18), inset -1px 0 1px rgba(0,0,0,0.18)",
            }}>
              Unknown
            </span>
          </span>
        );

      case "stopped":
      default:
        return (
          <span style={{
            ...housing,
            background: "linear-gradient(180deg, #150808 0%, #060202 100%)",
            border: "1px solid rgba(48,10,10,0.94)",
            boxShadow: "0 2px 7px rgba(0,0,0,0.85), 0 1px 2px rgba(0,0,0,0.65)",
          }}>
            <span style={{
              ...lens,
              background: [
                ribs(0.38),
                "linear-gradient(148deg, rgba(65,18,18,0.10) 0%, transparent 34%)",
                "radial-gradient(ellipse at 50% 58%, rgba(42,7,7,0.72) 0%, rgba(15,3,3,0.88) 55%, rgba(4,1,1,0.97) 100%)",
              ].join(", "),
              color: "rgba(60,42,42,0.82)",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.45), inset 0 -1px 1px rgba(0,0,0,0.28), inset 1px 0 1px rgba(0,0,0,0.18), inset -1px 0 1px rgba(0,0,0,0.18)",
            }}>
              Stopped
            </span>
          </span>
        );
    }
  };

  const getLogSourceColor = (source: string) => {
    switch (source) {
      case "git":      return "#4a9878";
      case "install":  return "#f2b8a0";
      case "frontend": return "#cc4444";
      case "backend":  return "#5080a8";
      case "system":
      default:         return "#3a3836";
    }
  };

  const logSectionRef = useRef<HTMLElement>(null);

  const DIV = "w-px h-4 flex-none hidden sm:block";
  const DIV_STYLE = { background: "#1e1e1e" };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground animate-in fade-in duration-300 relative overflow-hidden">

      <AmbientBackground anyRunning={anyRunning} bothRunning={bothRunning} dividerRef={logSectionRef} />

      {/* ── Header ── */}
      <header
        className="h-[56px] flex-none flex items-center px-5 gap-4 relative"
        style={{ borderBottom: "1px solid #161616", background: "rgba(7,7,7,0.92)" }}
      >
        {/* Brand */}
        <div
          className="flex items-center gap-3 flex-none"
          style={{ filter: "drop-shadow(0 0 10px rgba(204,34,34,0.14))" }}
        >
          <RepoRunnerLogo />
          <span
            className="select-none leading-none"
            style={{
              fontFamily: "'HS LunaObscura', 'Orbitron', 'Plus Jakarta Sans', sans-serif",
              fontSize: "14px",
              fontWeight: "normal",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              background: "linear-gradient(155deg, #eceae6 0%, #b0aca8 45%, #d8d4d0 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            RepoRunner
          </span>
        </div>

        <div className={DIV} style={DIV_STYLE} />

        {/* Project identity */}
        <div className="flex flex-col justify-center min-w-0 flex-1">
          <span
            className="text-[14px] leading-tight truncate"
            style={{ fontWeight: 600, color: "#dedad5" }}
          >
            {project.name}
          </span>
          <span
            className="text-[11px] leading-tight truncate mt-[3px]"
            style={{ ...MONO, color: "#434040" }}
            title={project.repoPath}
          >
            {project.repoPath}
          </span>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={onEdit}
          className="flex-none h-8 px-3 gap-1.5 text-[12px] font-medium"
          style={{ color: "#4a4845", background: "transparent" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#9a9896"; e.currentTarget.style.background = "#111"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#4a4845"; e.currentTarget.style.background = "transparent"; }}
        >
          <Settings2 className="w-3.5 h-3.5" />
          Edit Setup
        </Button>
      </header>

      {/* ── Main content ── */}
      <div className="flex-none w-full relative">
        <div className="max-w-5xl mx-auto px-5 py-5 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* Quick Actions */}
            <Card
              className="lg:col-span-2 rounded-xl"
              style={{
                background: "rgba(10,10,10,0.85)",
                border: "1px solid #1c1c1c",
                boxShadow: "0 4px 24px rgba(0,0,0,0.74), 0 0 0 1px rgba(204,34,34,0.05), inset 0 1px 0 rgba(204,34,34,0.07)",
              }}
            >
              <CardHeader className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid #191818" }}>
                <CardTitle style={{ ...LABEL, color: "#3a3836" }}>
                  Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5">
                <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
                  {/* Row 1 — Start Frontend, Start Backend, Stop Engine (3 equal) */}
                  <div style={{ display: "flex", gap: "0.625rem" }}>
                    <CommandButton
                      label="Start Frontend"
                      icon={Play}
                      onClick={wrapAction("startFront", window.repoRunner.startFrontend)}
                      disabled={statuses.frontend === "running" || statuses.frontend === "starting"}
                      loading={actionLoading["startFront"]}
                      variant="default"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                    <CommandButton
                      label="Start Backend"
                      icon={Play}
                      onClick={wrapAction("startBack", window.repoRunner.startBackend)}
                      disabled={statuses.backend === "running" || statuses.backend === "starting"}
                      loading={actionLoading["startBack"]}
                      variant="default"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                    <CommandButton
                      label="Stop Engine"
                      icon={SquareSquare}
                      onClick={wrapAction("stop", window.repoRunner.stopServices)}
                      disabled={bothStopped}
                      loading={actionLoading["stop"]}
                      variant="destructive"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                  </div>

                  {/* Row 2 — Pull Latest, Install, Restart All, Open Preview (4 equal) */}
                  <div style={{ display: "flex", gap: "0.625rem" }}>
                    <CommandButton
                      label="Pull"
                      icon={Download}
                      onClick={wrapAction("pull", window.repoRunner.pullLatest)}
                      loading={actionLoading["pull"]}
                      variant="outline"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                    <CommandButton
                      label="Install"
                      icon={Package}
                      onClick={wrapAction("install", window.repoRunner.runInstall)}
                      loading={actionLoading["install"]}
                      variant="outline"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                    <CommandButton
                      label="Restart"
                      icon={RotateCw}
                      onClick={wrapAction("restart", window.repoRunner.restartAll)}
                      loading={actionLoading["restart"]}
                      variant="outline"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                    <CommandButton
                      label="Open"
                      icon={ExternalLink}
                      onClick={wrapAction("preview", window.repoRunner.openPreview)}
                      loading={actionLoading["preview"]}
                      variant="outline"
                      style={{ flex: "1 1 0", justifyContent: "center", padding: "0 1rem" }}
                    />
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Services */}
            <Card
              className="rounded-xl"
              style={{
                background: "rgba(10,10,10,0.85)",
                border: "1px solid #1c1c1c",
                boxShadow: "0 4px 24px rgba(0,0,0,0.74), 0 0 0 1px rgba(204,34,34,0.05), inset 0 1px 0 rgba(204,34,34,0.07)",
              }}
            >
              <CardHeader className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid #191818" }}>
                <CardTitle style={{ ...LABEL, color: "#3a3836" }}>
                  Engine
                </CardTitle>
              </CardHeader>
              <CardContent className="p-5 flex flex-col gap-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium leading-none" style={{ color: "#7a7572" }}>
                      Frontend
                    </p>
                    {project.frontendPort && (
                      <p className="text-[11px] leading-none mt-2" style={{ ...MONO, color: "#383432" }}>
                        :{project.frontendPort}
                      </p>
                    )}
                  </div>
                  {getStatusDisplay(statuses.frontend)}
                </div>
                <Separator style={{ background: "#161616" }} />
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] font-medium leading-none" style={{ color: "#7a7572" }}>
                      Backend
                    </p>
                    {project.backendPort && (
                      <p className="text-[11px] leading-none mt-2" style={{ ...MONO, color: "#383432" }}>
                        :{project.backendPort}
                      </p>
                    )}
                  </div>
                  {getStatusDisplay(statuses.backend)}
                </div>
              </CardContent>
            </Card>

          </div>
        </div>
      </div>

      {/* ── Logs Panel ── */}
      <section
        ref={logSectionRef}
        className="flex-1 min-h-0 flex flex-col relative"
        style={{ borderTop: "1px solid #161616" }}
      >
        {/* Log toolbar */}
        <div
          className="flex-none h-[38px] flex items-center justify-between px-5"
          style={{
            borderBottom: "1px solid #131313",
            background: "linear-gradient(180deg, rgba(8,8,8,0.92) 0%, rgba(5,5,5,0.88) 100%)",
          }}
        >
          <div className="flex items-center gap-2.5">
            <span style={{ ...LABEL, color: "#4e4c4a" }}>
              App Logs
            </span>
            <span
              className="tabular-nums leading-none"
              style={{
                ...MONO,
                fontSize: "10px",
                color: "#4a4846",
                background: "#0d0d0d",
                border: "1px solid #202020",
                padding: "2px 6px",
                borderRadius: "3px",
              }}
            >
              {logs.length}
            </span>
          </div>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyLogs}
              className="h-6 px-2.5 gap-1.5 text-[11px] rounded"
              style={{ color: "#4a4846" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#9a9896"; e.currentTarget.style.background = "#111"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#4a4846"; e.currentTarget.style.background = "transparent"; }}
            >
              <Copy className="w-3 h-3" />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearLogs}
              className="h-6 px-2.5 gap-1.5 text-[11px] rounded"
              style={{ color: "#4a4846" }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "#9a9896"; e.currentTarget.style.background = "#111"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "#4a4846"; e.currentTarget.style.background = "transparent"; }}
            >
              <Trash2 className="w-3 h-3" />
              Clear
            </Button>
          </div>
        </div>

        {/* Log output */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto py-2"
          style={{ background: "rgba(5,5,5,0.80)", ...MONO, fontSize: "12px", lineHeight: "1.75" }}
        >
          {logs.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center gap-2 select-none">
              <span style={{ fontSize: "12px", color: "#484644", letterSpacing: "0.02em" }}>No logs yet</span>
              <span style={{ fontSize: "11px", color: "#383634", letterSpacing: "0.01em" }}>
                Run Pull, Install, or Start a service to see output here.
              </span>
            </div>
          ) : (
            <div>
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex gap-3 px-4 py-[4px] transition-colors"
                  onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = "rgba(204,34,34,0.025)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                >
                  <span
                    className="flex-none select-none tabular-nums w-[58px] text-right shrink-0"
                    style={{ color: "#525050" }}
                  >
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span
                    className="flex-none shrink-0 w-[72px] font-medium uppercase text-[10px] tracking-wider pt-[2px]"
                    style={{ color: getLogSourceColor(log.source) }}
                  >
                    [{log.source}]
                  </span>
                  <span className="whitespace-pre-wrap break-all min-w-0" style={{ color: "#7e7c7a" }}>
                    {log.text}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
