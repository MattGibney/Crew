import { ChevronDown as DisclosureChevronDown } from "lucide-react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { trackingPreferences } from "../../../src/shared/tracking.mjs";
import type { SetupSnapshot, CheckStatus } from "../contracts/setup.js";
import type * as React from "react";
function checkStatus(
  value: CheckStatus | CheckStatus[] | undefined,
): CheckStatus | undefined {
  return Array.isArray(value) ? undefined : value;
}
import { createContext, useContext } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  LoaderCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardHeader,
  CardContent,
  CardDescription,
} from "@/components/ui/card";
import { readableDetail } from "./model.js";

export const BusyContext = createContext(false);
export function SetupButton({
  allowDuringBusy = false,
  disabled,
  variant = "outline",
  children,
  ...props
}: React.ComponentProps<typeof Button> & { allowDuringBusy?: boolean }) {
  const busy = useContext(BusyContext);
  return (
    <Button
      type="button"
      variant={variant}
      disabled={disabled || (busy && !allowDuringBusy)}
      {...props}
    >
      {children}
    </Button>
  );
}
export function SetupCheckbox({
  disabled,
  ...props
}: React.ComponentProps<typeof Checkbox>) {
  const busy = useContext(BusyContext);
  return <Checkbox {...props} disabled={disabled || busy} />;
}
export function Select({
  disabled,
  children,
  ...props
}: React.ComponentProps<typeof NativeSelect>) {
  const busy = useContext(BusyContext);
  return (
    <NativeSelect className="w-full" disabled={disabled || busy} {...props}>
      {children}
    </NativeSelect>
  );
}
export function Field({
  id,
  label,
  value,
  onChange,
  hint,
  multiline = false,
  ...props
}: Omit<React.ComponentProps<"input">, "onChange" | "value"> & {
  label: string;
  value?: string | number | null;
  onChange: (value: string) => void;
  hint?: string;
  multiline?: boolean;
}) {
  const busy = useContext(BusyContext);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {multiline ? (
        <Textarea
          id={id}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className="min-h-32"
        />
      ) : (
        <Input
          id={id}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          disabled={busy}
          aria-describedby={hint ? `${id}-hint` : undefined}
          className={multiline ? "min-h-32" : undefined}
          {...props}
        />
      )}
      {hint && <Hint id={`${id}-hint`}>{hint}</Hint>}
    </div>
  );
}
export function Hint({
  children,
  className = "",
  ...props
}: React.ComponentProps<"p">) {
  return (
    <p
      className={`text-sm leading-relaxed text-muted-foreground ${className}`}
      {...props}
    >
      {children}
    </p>
  );
}
export function Actions({ children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className="flex flex-wrap items-center gap-2" {...props}>
      {children}
    </div>
  );
}
export function Panel({
  title,
  description,
  children,
  id,
  ...props
}: React.ComponentProps<"div"> & { title: string; description?: string }) {
  return (
    <Card id={id} className="shadow-none" {...props}>
      <CardHeader>
        <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
        {description && (
          <CardDescription className="leading-relaxed">
            {description}
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-6">{children}</CardContent>
    </Card>
  );
}
export function Status({
  name,
  value = { status: "unknown", detail: "Not checked." },
}: {
  name?: string;
  value?: CheckStatus;
}) {
  const status = value?.status || "unknown";
  const verified = ["verified", "configured", "granted", "running"].includes(
    status,
  );
  const failed = [
    "unavailable",
    "invalid",
    "denied",
    "blocked",
    "failed",
  ].includes(status);
  const Icon = verified
    ? CheckCircle2
    : failed
      ? AlertCircle
      : status === "checking"
        ? LoaderCircle
        : CircleHelp;
  return (
    <div
      className="status flex gap-3 rounded-lg border border-border bg-muted/30 p-3"
      data-status={status}
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 shrink-0 ${failed ? "text-destructive" : "text-muted-foreground"}`}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="font-medium">{name}</strong>
          <Badge variant={failed ? "destructive" : "secondary"}>{status}</Badge>
        </div>
        <p className="break-words text-sm leading-relaxed text-muted-foreground">
          {readableDetail(value?.detail)}
        </p>
      </div>
    </div>
  );
}
export function CheckList({
  snapshot,
  entries,
  id,
}: {
  snapshot: SetupSnapshot | null;
  entries: [keyof NonNullable<SetupSnapshot["checks"]>, string][];
  id?: string;
}) {
  return (
    <div id={id} className="space-y-2">
      {entries.map(([key, name]) => (
        <Status
          key={key}
          name={name}
          value={checkStatus(snapshot?.checks?.[key])}
        />
      ))}
    </div>
  );
}
export function ToolsCheck({ snapshot }: { snapshot: SetupSnapshot | null }) {
  const tools = snapshot?.checks?.tools;
  const authLabels: Record<string, string> = {
    unsupported: "No standard auth status reported",
    notLoggedIn: "Sign-in not reported",
    bearerToken: "Authentication managed by Codex",
    oAuth: "Authentication managed by Codex",
  };
  return (
    <div id="tools-result" className="space-y-2">
      <Status name="Connected tools" value={tools} />
      {snapshot?.config &&
        trackingPreferences(snapshot.config.project).providers.includes(
          "linear",
        ) &&
        tools?.linear && (
          <Status name="Linear read tools" value={tools.linear} />
        )}
      {snapshot?.config &&
        trackingPreferences(snapshot.config.project).providers.includes(
          "github",
        ) &&
        tools?.github && (
          <Status name="GitHub advertised tools" value={tools.github} />
        )}
      {(tools?.servers?.length ?? 0) > 0 && (
        <Collapsible className="space-y-3 rounded-lg border border-border p-3">
          <CollapsibleTrigger
            type="button"
            className="group flex w-full items-center gap-2 text-left cursor-pointer text-sm font-medium"
          >
            <DisclosureChevronDown
              className="size-4 shrink-0 transition-transform group-aria-expanded:rotate-180"
              aria-hidden="true"
            />
            Inspect {tools!.servers!.length} connected-tool entries
          </CollapsibleTrigger>
          <CollapsibleContent keepMounted>
            <div className="space-y-2 pt-3">
              {tools!.servers!.map((server, index) => (
                <Status
                  key={`${server.name}-${index}`}
                  name={server.name}
                  value={{
                    status: server.tools.length ? "advertised" : server.status,
                    detail: `${authLabels[server.auth] || server.auth}; ${server.tools.length} tools advertised. Access is not yet verified.`,
                  }}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}
