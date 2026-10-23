import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  GrantScope,
  ServiceConnectionView,
} from "../../../src/agents/contracts.mjs";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";

export function OwnerRequired() {
  return (
    <p className="py-6 text-sm text-muted-foreground">
      Only the project owner can manage access and service credentials.
    </p>
  );
}

export function AccessSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-5 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 id={id} className="text-base font-semibold">
            {title}
          </h2>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Choice({
  checked,
  onChange,
  disabled,
  children,
  description,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
  description?: ReactNode;
}) {
  return (
    <label className="flex min-w-0 items-start gap-3 py-2 text-sm">
      <Checkbox
        className="mt-1 shrink-0"
        checked={checked}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked === true)}
      />
      <span className="min-w-0 break-words">
        <span className="font-medium">{children}</span>
        {description && (
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

export function ErrorMessage({ children }: { children: string }) {
  return children ? (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  ) : null;
}

export function FormActions({
  busy,
  onCancel,
  disabled,
  label = "Save",
}: {
  busy: boolean;
  onCancel: () => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button type="submit" disabled={busy || disabled}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  );
}

/** Never display callback exception text: it may include credential material. */
export function useAccessAction(onNotify: (message: string) => void) {
  const active = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(
    action: () => Promise<void>,
    success: string,
    failure: string,
  ) {
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    setError("");
    let saved = false;
    try {
      await action();
      saved = true;
    } catch {
      setError(failure);
    } finally {
      active.current = false;
      setBusy(false);
    }
    if (saved) onNotify(success);
    return saved;
  }
  return { busy, error, setError, run };
}

export function ServiceIdentity({
  connection,
}: {
  connection?: ServiceConnectionView;
}) {
  if (!connection)
    return (
      <span className="text-muted-foreground">Connection unavailable</span>
    );
  const identity = connection.identity;
  return (
    <span className="break-words">
      {connection.name} · {connection.service}
      <span className="mt-1 block text-xs text-muted-foreground">
        Acts as {identity.displayName || "identity unverified"}
        {identity.emailAddress ? ` · ${identity.emailAddress}` : ""}
        {identity.externalAccountId
          ? ` · account ${identity.externalAccountId}`
          : ""}
      </span>
    </span>
  );
}

export function ScopeSummary({
  scope,
  exactArgumentsShown = false,
}: {
  scope: GrantScope;
  exactArgumentsShown?: boolean;
}) {
  return (
    <div className="space-y-2 break-words text-sm">
      {scope.type === "exact_operation" ? (
        <>
          <p>
            Only <code>{scope.operation}</code>
            {exactArgumentsShown
              ? " with exactly the arguments shown above."
              : " with the exact arguments approved for this grant."}
          </p>
          <Collapsible className="text-xs text-muted-foreground">
            <CollapsibleTrigger
              type="button"
              className="group flex w-full items-center gap-2 text-left cursor-pointer"
            >
              <DisclosureChevronDown
                className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
                aria-hidden="true"
              />
              Argument fingerprint
            </CollapsibleTrigger>
            <CollapsibleContent keepMounted>
              <p className="mt-2 break-all font-mono">
                {scope.argumentsFingerprint}
              </p>
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <>
          <p>
            Selected operations:{" "}
            <span className="font-mono">
              {scope.capabilities.join(", ") || "None"}
            </span>
          </p>
          {scope.constraints.length === 0 ? (
            <p className="font-medium">
              All schema-valid arguments for these operations. No argument
              restrictions.
            </p>
          ) : (
            <div>
              <p>
                Every argument restriction must match. A missing value is
                denied.
              </p>
              <ul className="mt-2 space-y-2">
                {scope.constraints.map((constraint, index) => (
                  <li key={index} className="rounded-lg bg-muted p-2 text-xs">
                    <code>{constraint.pointer || "(root)"}</code>
                    <span> must equal one of </span>
                    <code className="break-all">
                      {JSON.stringify(constraint.allowedValues)}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
