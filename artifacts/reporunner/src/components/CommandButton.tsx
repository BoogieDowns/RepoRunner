import { LucideIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface CommandButtonProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive" | "secondary" | "ghost" | "outline";
  loading?: boolean;
  style?: React.CSSProperties;
}

export function CommandButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  variant = "default",
  loading = false,
  style,
}: CommandButtonProps) {
  const glassClass =
    variant === "destructive"
      ? "btn-glass-danger"
      : variant === "default"
      ? "btn-glass-primary"
      : "btn-glass-secondary";

  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      data-testid={`button-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={cn(
        "btn-glass",
        glassClass,
        "hover:-translate-y-px active:translate-y-0 active:scale-[0.99]",
      )}
      style={style}
    >
      {/* Fixed-size icon box — guarantees every icon sits in an identical 20×20 slot */}
      <span style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, flexShrink: 0 }}>
        {loading
          ? <Loader2 className="h-[20px] w-[20px] animate-spin" />
          : <Icon className="h-[20px] w-[20px]" strokeWidth={1.5} />
        }
      </span>
      {/* Label — flex-centered so LunaObscura baseline sits on the shared centerline */}
      <span style={{
        display: "flex",
        alignItems: "center",
        fontFamily: "'HS LunaObscura', sans-serif",
        fontSize: "0.65rem",
        letterSpacing: "0.03em",
        lineHeight: 1,
      }}>{label}</span>
    </button>
  );
}
