import { useMemo, useState } from "react";
import { AlertTriangle, FolderOpen, RotateCw } from "lucide-react";
import type { ProjectStoreStatus } from "@/types";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  createSingleFlight,
  getNoticeContent,
  getRecoveryConfirmation,
  requiresConfirmation,
  type ProjectStoreNoticeAction,
} from "@/lib/projectStoreRecovery";

const secondaryButtonStyle: React.CSSProperties = {
  background: "#0d0d0d",
  border: "1px solid #2a1c1e",
  color: "#c8c0ba",
};

const destructiveButtonStyle: React.CSSProperties = {
  background: "#0d0809",
  border: "1px solid #351318",
  color: "#e0868f",
};

/**
 * Explains a saved-setups problem and offers only the actions the backend
 * reports as available. Nothing runs until the user clicks; replacement and
 * removal actions additionally need an explicit confirmation.
 */
export function ProjectStoreNotice({
  status,
  error,
  onAction,
}: {
  status: ProjectStoreStatus | null;
  /** Message from the last failed action, already safe to display. */
  error?: string | null;
  onAction: (action: ProjectStoreNoticeAction) => Promise<void>;
}) {
  const content = getNoticeContent(status);
  const singleFlight = useMemo(() => createSingleFlight(), []);
  const [runningAction, setRunningAction] = useState<ProjectStoreNoticeAction | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<ProjectStoreNoticeAction | null>(null);

  if (!status || !content) return null;

  const run = async (action: ProjectStoreNoticeAction) => {
    await singleFlight(async () => {
      setRunningAction(action);
      try {
        await onAction(action);
      } finally {
        setRunningAction(null);
      }
    });
  };

  const handleClick = (action: ProjectStoreNoticeAction) => {
    if (runningAction) return;
    if (requiresConfirmation(action)) {
      setPendingConfirmation(action);
      return;
    }
    void run(action);
  };

  const confirmation = pendingConfirmation ? getRecoveryConfirmation(pendingConfirmation, status) : null;
  const blocking = content.kind !== "unavailable-entries";

  return (
    <div
      className="rounded-lg px-4 py-3.5"
      style={{
        background: blocking ? "#14070a" : "#0e0909",
        border: `1px solid ${blocking ? "#4a1218" : "#2e1a1c"}`,
      }}
      role="alert"
      data-testid="project-store-notice"
      data-kind={content.kind}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 flex-none"
          style={{ color: blocking ? "#ff8a94" : "#d18a90" }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-sm font-semibold" style={{ color: "#f0d6d8" }}>
            {content.title}
          </p>
          {content.message.map((line) => (
            <p key={line} className="text-[0.78rem] leading-relaxed" style={{ color: "#c8b4b6" }}>
              {line}
            </p>
          ))}
          {content.details.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[0.72rem]" style={{ color: "#9a8a8c" }}>
              {content.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          {error && (
            <p
              className="rounded-md border border-[#4a1218]/70 bg-[#1a080a]/70 px-2.5 py-1.5 text-[0.72rem] font-medium leading-snug text-[#ff8a94]"
              data-testid="project-store-notice-error"
            >
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            {content.actions.map(({ action, label }) => (
              <button
                key={action}
                type="button"
                onClick={() => handleClick(action)}
                disabled={runningAction !== null}
                data-testid={`store-action-${action}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={requiresConfirmation(action) ? destructiveButtonStyle : secondaryButtonStyle}
              >
                {action === "retry" && <RotateCw className="h-3.5 w-3.5" />}
                {action === "reveal" && <FolderOpen className="h-3.5 w-3.5" />}
                {runningAction === action ? "Working..." : label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <AlertDialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingConfirmation(null);
        }}
      >
        {confirmation && pendingConfirmation && (
          <AlertDialogContent
            data-testid="store-confirm-dialog"
            style={{ background: "#0a0a0a", border: "1px solid #2a1c1e", color: "#dedad5" }}
          >
            <AlertDialogHeader>
              <AlertDialogTitle style={{ color: "#f0d6d8" }}>{confirmation.title}</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm" style={{ color: "#b8a8aa" }}>
                  {confirmation.description.map((line) => (
                    <p key={line}>{line}</p>
                  ))}
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel
                data-testid="store-confirm-cancel"
                style={{ background: "#0d0d0d", border: "1px solid #242020", color: "#9a9896" }}
              >
                Cancel
              </AlertDialogCancel>
              <button
                type="button"
                data-testid="store-confirm-accept"
                disabled={runningAction !== null}
                className="inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium disabled:opacity-50"
                style={destructiveButtonStyle}
                onClick={() => {
                  const action = pendingConfirmation;
                  setPendingConfirmation(null);
                  void run(action);
                }}
              >
                {confirmation.confirmLabel}
              </button>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </div>
  );
}
