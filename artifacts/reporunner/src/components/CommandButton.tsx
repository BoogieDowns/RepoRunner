import { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

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
  return (
    <Button
      variant={variant}
      onClick={onClick}
      disabled={disabled || loading}
      data-testid={`button-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className="w-full flex flex-col items-center justify-center gap-2 h-24 sm:h-32 transition-all hover-elevate hover:-translate-y-0.5 active:translate-y-0"
    >
      {loading ? (
        <div className="h-6 w-6 sm:h-8 sm:w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <Icon className="h-6 w-6 sm:h-8 sm:w-8" strokeWidth={1.5} />
      )}
      <span className="font-medium tracking-tight text-sm sm:text-base">{label}</span>
    </Button>
  );
}
