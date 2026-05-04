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
        "disabled:opacity-25 disabled:cursor-not-allowed disabled:pointer-events-none disabled:shadow-none",
        "hover:-translate-y-px active:translate-y-0 active:scale-[0.99]",
        variant === "default" && [
          "!bg-[#0f0808] !border !border-[#cc2222]/35 !text-[#d93030]",
          "hover:!bg-[#150a0a] hover:!border-[#cc2222]/60 hover:!text-[#e03030]",
          "shadow-[0_0_10px_rgba(204,34,34,0.12)]",
          "hover:shadow-[0_0_16px_rgba(204,34,34,0.22)]",
        ],
        variant === "destructive" && [
          "shadow-[0_0_14px_rgba(204,34,34,0.28)]",
          "hover:shadow-[0_0_22px_rgba(204,34,34,0.40)]",
        ],
        variant === "outline" && [
          "!border-[#1e1e1e] !text-[#6a6864] !bg-transparent",
          "hover:!bg-[#111] hover:!text-[#9a9896] hover:!border-[#2a2828]",
        ],
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
