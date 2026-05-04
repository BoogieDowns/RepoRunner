import { LucideIcon, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface CommandButtonProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "destructive" | "secondary" | "ghost" | "outline";
  loading?: boolean;
}

export function CommandButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  variant = "default",
  loading = false,
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
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin flex-none" />
      ) : (
        <Icon className="h-4 w-4 flex-none" strokeWidth={1.5} />
      )}
      <span>{label}</span>
    </button>
  );
}
