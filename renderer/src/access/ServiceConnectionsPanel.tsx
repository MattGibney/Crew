import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Fragment } from "react";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { ServiceLogo } from "@/components/service-logo";
import {
  Table,
  TableCaption,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useId, useState } from "react";
import type { CSSProperties } from "react";
import type { ServiceConnection } from "../../../src/agents/contracts.mjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type {
  ConnectionDraft,
  ConnectionSave,
  ConnectionSetupChoice,
  OwnerPanelProps,
} from "./types";
import {
  AccessSection,
  ErrorMessage,
  FormActions,
  OwnerRequired,
  ServiceIdentity,
  useAccessAction,
} from "./shared";

export interface ServiceConnectionsPanelProps extends OwnerPanelProps {
  connections: readonly ServiceConnection[];
  setupChoices: readonly ConnectionSetupChoice[];
  /** Mount the shared provider/account/verification wizard from Settings. */
  onConnect?: () => void;
  onSave: (change: ConnectionSave) => Promise<void>;
  onRemove: (connectionId: string, expectedRevision: number) => Promise<void>;
  /** Trusted gateway discovery check, independent of saving metadata or reconnecting auth. */
  onVerify?: (connectionId: string, expectedRevision: number) => Promise<void>;
  /** Gateway-owned authentication flow. Omit when that adapter is unavailable. */
  onReconnect?: (
    connectionId: string,
    expectedRevision: number,
  ) => Promise<void>;
}

export function ServiceConnectionsPanel(props: ServiceConnectionsPanelProps) {
  return props.isOwner ? (
    <ServiceConnectionsContent {...props} />
  ) : (
    <OwnerRequired />
  );
}

const connectionStates: Record<ServiceConnection["observedState"], string> = {
  unknown: "Not verified",
  connected: "Connected",
  "reauthentication-required": "Sign-in required",
  error: "Connection error",
};

function ServiceConnectionsContent(props: ServiceConnectionsPanelProps) {
  const [editing, setEditing] = useState<ServiceConnection | "new" | null>(
    null,
  );
  const [removing, setRemoving] = useState<ServiceConnection | null>(null);
  const action = useAccessAction(props.onNotify);
  return (
    <AccessSection
      fullWidth
      title="Connections"
      description="Manage service accounts shared with your agents through groups."
      action={
        <div className="flex flex-wrap gap-2">
          {props.onConnect && (
            <Button
              disabled={editing !== null || action.busy}
              onClick={props.onConnect}
            >
              Connect service
            </Button>
          )}
          <Button
            variant={props.onConnect ? "ghost" : "default"}
            disabled={
              editing !== null || action.busy || !props.setupChoices.length
            }
            onClick={() => {
              setRemoving(null);
              setEditing("new");
            }}
          >
            {props.onConnect ? "Advanced connection" : "Add connection"}
          </Button>
        </div>
      }
    >
      {!props.setupChoices.length && (
        <p className="text-sm text-muted-foreground">
          No service adapters are configured. Available connection options come
          from the gateway.
        </p>
      )}
      {editing && (
        <ConnectionEditor
          key={editing === "new" ? "new" : editing.id}
          {...props}
          connection={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <div className="overflow-x-auto rounded-lg border">
        <Table className="w-full text-left text-sm">
          <TableCaption className="sr-only">
            Service connections and their accounts
          </TableCaption>
          <TableHeader className="border-b bg-muted/30 text-xs text-muted-foreground">
            <TableRow>
              <TableHead className="px-4 py-3 font-medium">Service</TableHead>
              <TableHead className="px-4 py-3 font-medium">
                Connection
              </TableHead>
              <TableHead className="px-4 py-3 font-medium">Account</TableHead>
              <TableHead className="px-4 py-3 font-medium">Status</TableHead>
              <TableHead className="px-4 py-3 font-medium">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="divide-y">
            {!props.connections.length && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="px-4 py-8 text-muted-foreground"
                >
                  No service connections yet.
                </TableCell>
              </TableRow>
            )}
            {props.connections.map((connection) => (
              <Fragment key={connection.id}>
                <TableRow>
                  <TableCell className="px-4 py-3 capitalize text-muted-foreground">
                    <span className="flex items-center gap-2.5">
                      <ServiceLogo service={connection.service} />
                      {connection.service.toLowerCase() === "github"
                        ? "GitHub"
                        : connection.service}
                    </span>
                  </TableCell>
                  <TableCell className="px-4 py-3 font-medium">
                    {connection.name}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">
                    {connection.identity.displayName || "Identity unverified"}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-muted-foreground">
                    <span>{connectionStates[connection.observedState]}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {connection.lastVerifiedAt
                        ? `Verified ${new Date(connection.lastVerifiedAt).toLocaleString()}`
                        : "No verification recorded"}
                    </span>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Actions for ${connection.name}`}
                            disabled={editing !== null || action.busy}
                          />
                        }
                      >
                        <MoreVertical aria-hidden="true" className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {props.onVerify && (
                          <DropdownMenuItem
                            disabled={editing !== null || action.busy}
                            onClick={() =>
                              void action.run(
                                () =>
                                  props.onVerify!(
                                    connection.id,
                                    connection.revision,
                                  ),
                                "Connection verification completed. Check its current status.",
                                "Could not verify this connection. Check its service credential and configured adapter.",
                              )
                            }
                          >
                            Verify connection
                          </DropdownMenuItem>
                        )}
                        {props.onReconnect && (
                          <DropdownMenuItem
                            disabled={editing !== null || action.busy}
                            onClick={() =>
                              void action.run(
                                () =>
                                  props.onReconnect!(
                                    connection.id,
                                    connection.revision,
                                  ),
                                "Connection sign-in flow completed. Check its current verification status.",
                                "Could not reconnect this service. Check the gateway's authentication availability and try again.",
                              )
                            }
                          >
                            Reconnect
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          disabled={editing !== null || action.busy}
                          aria-label={`Update ${connection.name}`}
                          onClick={() => {
                            setRemoving(null);
                            setEditing(connection);
                          }}
                        >
                          <Pencil aria-hidden="true" className="size-4" />
                          Update
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={editing !== null || action.busy}
                          variant="destructive"
                          aria-label={`Remove ${connection.name}`}
                          onClick={() => setRemoving(connection)}
                        >
                          <Trash2 aria-hidden="true" className="size-4" />
                          Remove
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
                {removing?.id === connection.id && (
                  <TableRow>
                    <TableCell colSpan={5} className="whitespace-normal py-4">
                      {" "}
                      {removing?.id === connection.id && (
                        <div className="space-y-3 border-t pt-4">
                          <p className="text-sm">
                            Remove {removing.name}? Agents will lose this
                            connection. Calls already admitted may finish. The
                            external service account is not deleted.
                          </p>
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button
                              variant="ghost"
                              disabled={action.busy}
                              onClick={() => setRemoving(null)}
                            >
                              Keep connection
                            </Button>
                            <Button
                              variant="destructive"
                              disabled={action.busy}
                              onClick={async () => {
                                if (
                                  await action.run(
                                    () =>
                                      props.onRemove(
                                        removing.id,
                                        removing.revision,
                                      ),
                                    "Service connection removed.",
                                    "Could not remove the connection. Refresh its current state and try again.",
                                  )
                                )
                                  setRemoving(null);
                              }}
                            >
                              Confirm removal
                            </Button>
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                )}
                {connection.authentication.method === "oauth" &&
                  connection.service !== "gmail" &&
                  !props.onReconnect && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="whitespace-normal text-xs text-muted-foreground"
                      >
                        OAuth reconnect is unavailable until the gateway
                        authentication adapter is connected.
                      </TableCell>
                    </TableRow>
                  )}
              </Fragment>
            ))}
          </TableBody>
        </Table>
      </div>
      <ErrorMessage>{action.error}</ErrorMessage>
      <p className="text-xs leading-5 text-muted-foreground">
        Codex model access uses subscription sign-in and is managed separately.
        A service connection does not change model authentication.
      </p>
    </AccessSection>
  );
}

function sameTransport(
  left: ServiceConnection["transport"],
  right: ServiceConnection["transport"],
) {
  return left.type === "mcp" && right.type === "mcp"
    ? left.serverConfigRef === right.serverConfigRef
    : left.type === "cli" &&
        right.type === "cli" &&
        left.executorConfigRef === right.executorConfigRef;
}

function ConnectionEditor({
  connection,
  onClose,
  ...props
}: ServiceConnectionsPanelProps & {
  connection: ServiceConnection | null;
  onClose: () => void;
}) {
  const id = useId();
  const [choiceId, setChoiceId] = useState(() =>
    connection
      ? (props.setupChoices.find(
          (choice) =>
            choice.service === connection.service &&
            sameTransport(choice.transport, connection.transport),
        )?.id ?? "")
      : (props.setupChoices[0]?.id ?? ""),
  );
  const choice = props.setupChoices.find((option) => option.id === choiceId);
  const [draft, setDraft] = useState<ConnectionDraft>(() => ({
    name: connection?.name ?? "",
    service: connection?.service ?? choice?.service ?? "",
    identity: connection
      ? { ...connection.identity }
      : { displayName: "", externalAccountId: null, emailAddress: null },
    transport: connection?.transport ??
      choice?.transport ?? { type: "mcp", serverConfigRef: "" },
    authenticationMethod:
      connection?.authentication.method ??
      choice?.authenticationMethods[0] ??
      "none",
  }));
  const [credential, setCredential] = useState("");
  const action = useAccessAction(props.onNotify);
  const methods = [
    ...new Set([
      ...(choice?.authenticationMethods ?? []),
      ...(connection ? [connection.authentication.method] : []),
    ]),
  ];
  const needsCredential =
    draft.authenticationMethod === "token" ||
    draft.authenticationMethod === "ssh-key" ||
    (draft.authenticationMethod === "oauth" && draft.service === "gmail");
  const changedAuthentication =
    !connection ||
    draft.authenticationMethod !== connection.authentication.method;
  const valid =
    draft.name.trim() &&
    draft.identity.displayName.trim() &&
    (choice || connection) &&
    (!needsCredential || !changedAuthentication || credential.length > 0);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !action.busy) {
          setCredential("");
          onClose();
        }
      }}
    >
      <DialogContent
        className="flex max-h-[85dvh] flex-col sm:max-w-xl"
        showCloseButton={!action.busy}
      >
        <DialogHeader>
          <DialogTitle>
            {connection ? "Edit connection" : "Add connection"}
          </DialogTitle>
          <DialogDescription>
            {connection
              ? `Update ${connection.name}.`
              : "Choose a service and the account Crew should use."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-h-0 flex-col gap-5"
          autoComplete="off"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid || action.busy) return;
            const privateCredential =
              needsCredential && credential ? credential : null;
            // Clear on every submission, including rejected saves. Never restore private material.
            setCredential("");
            const saved = await action.run(
              () =>
                props.onSave({
                  id: connection?.id ?? null,
                  expectedRevision: connection?.revision ?? null,
                  draft: {
                    ...draft,
                    name: draft.name.trim(),
                    identity: {
                      displayName: draft.identity.displayName.trim(),
                      emailAddress: draft.identity.emailAddress?.trim() || null,
                      externalAccountId:
                        draft.identity.externalAccountId?.trim() || null,
                    },
                  },
                  credential: privateCredential,
                }),
              "Service connection saved. Verification is shown separately.",
              "Could not save this connection. Refresh its current state; enter the private credential again if needed.",
            );
            if (saved) onClose();
          }}
        >
          <div className="min-h-0 space-y-5 overflow-y-auto px-1">
            {connection &&
              props.connections.find((row) => row.id === connection.id)
                ?.revision !== connection.revision && (
                <p role="alert" className="text-sm text-destructive">
                  This connection changed while you were editing. Your draft is
                  retained. Cancel and reopen Update to use the current
                  revision.
                </p>
              )}
            <fieldset disabled={action.busy} className="space-y-5">
              <legend className="sr-only">
                {connection
                  ? `Update ${connection.name}`
                  : "Add service connection"}
              </legend>
              <div className="space-y-2">
                <Label htmlFor={`${id}-adapter`}>Service adapter</Label>
                <Select
                  value={choiceId}
                  disabled={!!connection}
                  onValueChange={(selectedValue) => {
                    const next = props.setupChoices.find(
                      (option) => option.id === (selectedValue ?? ""),
                    );
                    if (!next) return;
                    setChoiceId(next.id);
                    setCredential("");
                    setDraft({
                      ...draft,
                      service: next.service,
                      transport: next.transport,
                      authenticationMethod:
                        next.authenticationMethods[0] ?? "none",
                    });
                  }}
                  items={[
                    ...(!choice
                      ? [
                          {
                            value: choiceId,
                            label: "Current adapter unavailable",
                          },
                        ]
                      : []),
                    ...props.setupChoices.map((option) => ({
                      value: option.id,
                      label: option.label,
                    })),
                  ]}
                >
                  <SelectTrigger id={`${id}-adapter`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {!choice && (
                      <SelectItem value={choiceId} disabled>
                        Current adapter unavailable
                      </SelectItem>
                    )}
                    {props.setupChoices.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor={`${id}-name`}>Connection name</Label>
                <Input
                  id={`${id}-name`}
                  required
                  maxLength={120}
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </div>
              <fieldset className="space-y-3" disabled={!!connection}>
                <legend className="mb-2 text-sm font-medium">
                  Acting identity
                </legend>
                <p className="text-xs leading-5 text-muted-foreground">
                  {connection
                    ? "Create a new connection to use another service account or executor."
                    : "The service account agents will act as. Saving these details does not verify the account."}
                </p>
                <div className="space-y-2">
                  <Label htmlFor={`${id}-display`}>Display name</Label>
                  <Input
                    id={`${id}-display`}
                    required
                    maxLength={160}
                    value={draft.identity.displayName}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        identity: {
                          ...draft.identity,
                          displayName: event.target.value,
                        },
                      })
                    }
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-email`}>Email (optional)</Label>
                    <Input
                      id={`${id}-email`}
                      type="email"
                      maxLength={254}
                      value={draft.identity.emailAddress ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          identity: {
                            ...draft.identity,
                            emailAddress: event.target.value || null,
                          },
                        })
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-account`}>
                      Account ID (optional)
                    </Label>
                    <Input
                      id={`${id}-account`}
                      maxLength={300}
                      value={draft.identity.externalAccountId ?? ""}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          identity: {
                            ...draft.identity,
                            externalAccountId: event.target.value || null,
                          },
                        })
                      }
                    />
                  </div>
                </div>
              </fieldset>
              <div className="space-y-2">
                <Label htmlFor={`${id}-authentication`}>
                  Service authentication
                </Label>
                <Select
                  value={draft.authenticationMethod}
                  onValueChange={(selectedValue) => {
                    const method = methods.find(
                      (value) => value === (selectedValue ?? ""),
                    );
                    if (!method) return;
                    setCredential("");
                    setDraft({ ...draft, authenticationMethod: method });
                  }}
                  items={methods.map((method) => ({
                    value: method,
                    label:
                      method === "oauth"
                        ? draft.service === "gmail"
                          ? "Google OAuth credential bundle"
                          : "OAuth sign-in"
                        : method === "token"
                          ? "Service token"
                          : method === "ssh-key"
                            ? "SSH key"
                            : "No authentication",
                  }))}
                >
                  <SelectTrigger id={`${id}-authentication`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {methods.map((method) => (
                      <SelectItem key={method} value={method}>
                        {method === "oauth"
                          ? draft.service === "gmail"
                            ? "Google OAuth credential bundle"
                            : "OAuth sign-in"
                          : method === "token"
                            ? "Service token"
                            : method === "ssh-key"
                              ? "SSH key"
                              : "No authentication"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {needsCredential && (
                <div className="space-y-2">
                  <Label htmlFor={`${id}-credential`}>
                    {changedAuthentication
                      ? "Private credential"
                      : "Replace private credential (optional)"}
                  </Label>
                  {draft.authenticationMethod === "ssh-key" ? (
                    <Textarea
                      id={`${id}-credential`}
                      name="private-credential"
                      aria-describedby={`${id}-credential-help`}
                      required={changedAuthentication}
                      rows={4}
                      maxLength={65536}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      style={{ WebkitTextSecurity: "disc" } as CSSProperties}
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                    />
                  ) : (
                    <Input
                      id={`${id}-credential`}
                      name="private-credential"
                      aria-describedby={`${id}-credential-help`}
                      type="password"
                      required={changedAuthentication}
                      maxLength={65536}
                      autoComplete="new-password"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                    />
                  )}
                  <p
                    id={`${id}-credential-help`}
                    className="text-xs leading-5 text-muted-foreground"
                  >
                    Stored privately for this service, outside agent
                    instructions. Cleared from this editor when you submit or
                    close it.{" "}
                    {connection && !changedAuthentication
                      ? "Leave blank to keep the current credential."
                      : ""}
                  </p>
                </div>
              )}
              {draft.authenticationMethod === "oauth" && (
                <p className="text-sm text-muted-foreground">
                  {draft.service === "gmail"
                    ? "Enter the explicit Google OAuth credential bundle from your own approved OAuth client. All fields are vaulted; the fixed Google refresh endpoint is used. Reverify after replacing credentials."
                    : "Save the connection, then use Reconnect when its gateway authentication adapter is available. Do not paste OAuth tokens here."}
                </p>
              )}
            </fieldset>
            <ErrorMessage>{action.error}</ErrorMessage>
          </div>
          <DialogFooter>
            <FormActions
              label={connection ? "Save changes" : "Add connection"}
              busy={action.busy}
              disabled={!valid}
              onCancel={() => {
                setCredential("");
                onClose();
              }}
            />
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
