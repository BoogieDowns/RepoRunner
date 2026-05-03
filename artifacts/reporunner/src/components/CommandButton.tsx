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
      size="sm"
      className="flex items-center gap-2 h-9 sm:h-10 disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none"
    >
      {loading ? (
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        <Icon className="h-4 w-4" strokeWidth={1.5} />
      )}
      <span className="font-medium tracking-tight text-sm">{label}</span>
    </Button>
  );
}
