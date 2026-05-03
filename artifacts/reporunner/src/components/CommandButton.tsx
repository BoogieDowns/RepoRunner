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
        "disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none disabled:shadow-none",
        "hover:-translate-y-px active:translate-y-0 active:scale-[0.99]",
        variant === "default" && [
          "shadow-[0_0_14px_rgba(30,255,90,0.22)]",
          "hover:shadow-[0_0_20px_rgba(30,255,90,0.32)]",
          "active:shadow-[0_0_8px_rgba(30,255,90,0.15)]",
        ],
        variant === "destructive" && [
          "shadow-[0_0_10px_rgba(201,75,87,0.15)]",
          "hover:shadow-[0_0_14px_rgba(201,75,87,0.25)]",
        ],
        variant === "outline" && [
          "border-[#1f4132] text-[#7FA18B] bg-transparent",
          "hover:bg-[#0f1a14] hover:text-[#B8FFCA] hover:border-[#2a5542]",
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
