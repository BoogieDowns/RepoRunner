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
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading}
      data-testid={`button-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={cn("btn-glass", glassClass)}
      style={style}
    >
      <span className="btn-glass__icon">
        {loading ? (
          <Loader2 className="h-[20px] w-[20px] animate-spin" />
        ) : (
          <Icon className="h-[20px] w-[20px]" strokeWidth={1.5} />
        )}
      </span>
      <span className="btn-glass__label">{label}</span>
    </button>
  );
}
