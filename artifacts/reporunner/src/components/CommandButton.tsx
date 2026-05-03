import { LucideIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={onClick}
      disabled={disabled || loading}
      data-testid={`button-${label.toLowerCase().replace(/\s+/g, "-")}`}
      className={cn(
        "flex items-center gap-2 h-9 px-3.5 font-medium text-[13px] rounded-lg transition-all duration-150",
        "disabled:opacity-35 disabled:cursor-not-allowed disabled:pointer-events-none",
        "hover:-translate-y-px active:translate-y-0 active:scale-[0.99]"
      )}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Icon className="h-4 w-4" strokeWidth={1.5} />
      )}
      <span>{label}</span>
    </Button>
  );
}
