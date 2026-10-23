import { useEffect, useRef } from "react";
import { toast } from "sonner";

export function SettingsToast({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss(): void;
}) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    const id = toast.success(message, {
      duration: 5000,
      onDismiss: () => dismiss.current(),
      onAutoClose: () => dismiss.current(),
    });
    return () => {
      toast.dismiss(id);
    };
  }, [message]);
  return null;
}
