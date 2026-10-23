import { useEffect, useId, useRef, useState } from "react";
import type {
  AccessOwnerView,
  OwnerConnectionAccessSelection,
  OwnerConnectionVerification,
} from "../../../src/access/owner-contracts.mjs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { WebLink } from "../manager/WebLink";
import { Choice, ErrorMessage, OwnerRequired } from "./shared";
import type { OwnerPanelProps } from "./types";

export interface ServiceConnectionWizardProps extends OwnerPanelProps {
  snapshot: AccessOwnerView;
  onCommand(name: string, args: unknown): Promise<unknown>;
  onComplete?(connectionId: string): void;
  onCancel(): void;
  /** Onboarding may continue with local work without adding a service. */
  onSkip?(): void;
}

type GroupSelection = {
  groupId: string;
  expectedRevision: number;
  capabilityIds: string[];
};
type AgentSelection = {
  agentId: string;
  expectedRevision: number | null;
  permissionGroupIds: string[];
};
const steps = ["Service", "Account", "Verify", "Access", "Review"];

/** Owner-only, embeddable flow. State is transient and survives snapshot refresh;
 * changing projects unmounts it and discards the previous private request. */
export function ServiceConnectionWizard(props: ServiceConnectionWizardProps) {
  return props.isOwner ? (
    <ConnectionWizardContent key={props.snapshot.projectId} {...props} />
  ) : (
    <OwnerRequired />
  );
}

function ConnectionWizardContent(props: ServiceConnectionWizardProps) {
  const id = useId();
  const { snapshot } = props;
  const [step, setStep] = useState(0);
  const [selection, setSelection] = useState("");
  const [accountKind, setAccountKind] = useState<"personal" | "dedicated" | "">(
    "",
  );
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [verification, setVerification] =
    useState<OwnerConnectionVerification | null>(null);
  const [groups, setGroups] = useState<GroupSelection[]>([]);
  const [agents, setAgents] = useState<AgentSelection[]>([]);
  const [busy, setBusy] = useState<"verify" | "save" | "cancel" | null>(null);
  const [error, setError] = useState("");
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [savedConnectionId, setSavedConnectionId] = useState<string | null>(
    null,
  );
  const [currentTime, setCurrentTime] = useState(Date.now());
  const savePayload = useRef<OwnerConnectionAccessSelection | null>(null);
  const requestId = useRef(crypto.randomUUID());
  const requestStarted = useRef(false);
  const lastVerificationMetadata = useRef("");
  const generation = useRef(0);
  const committed = useRef(false);
  const command = useRef(props.onCommand);
  command.current = props.onCommand;
  useEffect(
    () => () => {
      generation.current += 1;
      if (requestStarted.current && !committed.current)
        void command
          .current("discardConnectionDraft", { requestId: requestId.current })
          .catch(() => {});
    },
    [],
  );
  useEffect(() => {
    if (!verification) return;
    const timer = window.setTimeout(
      () => setCurrentTime(Date.now()),
      Math.max(0, Date.parse(verification.expiresAt) - Date.now()) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [verification]);

  const existing = selection.startsWith("existing:")
    ? snapshot.connections.find((row) => row.id === selection.slice(9))
    : undefined;
  const [existingRevision, setExistingRevision] = useState<number | null>(null);
  const choice = snapshot.setupChoices.find((row) =>
    existing
      ? row.service === existing.service &&
        (row.transport.type === "mcp" && existing.transport.type === "mcp"
          ? row.transport.serverConfigRef === existing.transport.serverConfigRef
          : row.transport.type === "cli" &&
            existing.transport.type === "cli" &&
            row.transport.executorConfigRef ===
              existing.transport.executorConfigRef)
      : row.id === selection.slice(4),
  );
  const guide = choice?.guide;
  const groupConflicts = groups.some(
    (selected) =>
      snapshot.groups.find((row) => row.id === selected.groupId)?.revision !==
      selected.expectedRevision,
  );
  const agentConflicts = agents.some(
    (selected) =>
      !snapshot.agents.some((row) => row.id === selected.agentId) ||
      (snapshot.assignments.find((row) => row.agentId === selected.agentId)
        ?.revision ?? null) !== selected.expectedRevision,
  );
  const connectionConflict =
    selection.startsWith("existing:") &&
    (!existing || existing.revision !== existingRevision);
  const expired =
    verification !== null && Date.parse(verification.expiresAt) <= currentTime;
  const accessConflict = groupConflicts || agentConflicts;
  const selectedGroupIds = groups.map((row) => row.groupId);

  async function leave(skip = false) {
    if (busy === "save" || saveAttempted) return;
    generation.current += 1;
    setCredential("");
    setBusy("cancel");
    setError("");
    try {
      if (requestStarted.current)
        await props.onCommand("discardConnectionDraft", {
          requestId: requestId.current,
        });
      committed.current = true;
      if (skip) props.onSkip?.();
      else props.onCancel();
    } catch {
      setError(
        "Could not confirm cancellation. Your connection has not been saved by this flow. Try cancelling again.",
      );
      setBusy(null);
    }
  }

  async function back() {
    if (busy || saveAttempted) return;
    if (step === 2 && requestStarted.current) {
      setBusy("cancel");
      setCredential("");
      try {
        await props.onCommand("discardConnectionDraft", {
          requestId: requestId.current,
        });
        requestId.current = crypto.randomUUID();
        requestStarted.current = false;
        lastVerificationMetadata.current = "";
        setVerification(null);
      } catch {
        setError(
          "Could not discard the previous verification. Try again before changing the connection details.",
        );
        return;
      } finally {
        setBusy(null);
      }
    }
    setError("");
    setStep(step - 1);
  }

  async function verify() {
    if (
      !choice ||
      !accountKind ||
      !name.trim() ||
      busy ||
      (!existing && !credential)
    )
      return;
    const currentGeneration = ++generation.current;
    const privateCredential = existing ? null : credential;
    const metadata = JSON.stringify({
      setupChoiceId: choice.id,
      name: name.trim(),
      accountKind,
      connectionId: existing?.id ?? null,
      expectedRevision: existingRevision,
    });
    setCredential("");
    setError("");
    setVerification(null);
    setBusy("verify");
    try {
      // Corrected credentials and edited account details use a new request.
      if (
        requestStarted.current &&
        (privateCredential !== null ||
          lastVerificationMetadata.current !== metadata)
      ) {
        await props.onCommand("discardConnectionDraft", {
          requestId: requestId.current,
        });
        if (currentGeneration !== generation.current) return;
        requestId.current = crypto.randomUUID();
        requestStarted.current = false;
      }
      requestStarted.current = true;
      lastVerificationMetadata.current = metadata;
      const result = (await props.onCommand("verifyConnectionDraft", {
        requestId: requestId.current,
        setupChoiceId: choice.id,
        name: name.trim(),
        accountKind,
        credential: privateCredential,
        connectionId: existing?.id ?? null,
        expectedRevision: existingRevision,
      })) as OwnerConnectionVerification;
      if (currentGeneration !== generation.current) return;
      if (
        result.requestId !== requestId.current ||
        result.state !== "verified" ||
        !result.verificationId ||
        result.capabilitiesStatus !== "verified"
      ) {
        setError(
          result.reason?.slice(0, 800) ||
            "Verification did not complete. Check the account token and provider permissions, then try again. No connection has been saved.",
        );
        return;
      }
      setVerification(result);
      setCurrentTime(Date.now());
      setGroups([]);
      setAgents([]);
    } catch {
      if (currentGeneration === generation.current)
        setError(
          "Could not verify this connection. Check the provider, token and account access, then enter the token again to retry.",
        );
    } finally {
      if (currentGeneration === generation.current) setBusy(null);
    }
  }

  function refreshAccessReview() {
    setGroups((current) =>
      current.flatMap((selection) => {
        const group = snapshot.groups.find(
          (row) => row.id === selection.groupId,
        );
        return group
          ? [{ ...selection, expectedRevision: group.revision }]
          : [];
      }),
    );
    setAgents((current) =>
      current
        .filter((selection) =>
          snapshot.agents.some((row) => row.id === selection.agentId),
        )
        .map((selection) => ({
          ...selection,
          expectedRevision:
            snapshot.assignments.find(
              (row) => row.agentId === selection.agentId,
            )?.revision ?? null,
        })),
    );
    setError("");
    setReviewRequired(false);
    setStep(3);
  }

  async function save() {
    if (
      !verification?.verificationId ||
      busy ||
      savedConnectionId ||
      (!saveAttempted && (connectionConflict || accessConflict || expired))
    )
      return;
    setBusy("save");
    setSaveAttempted(true);
    setError("");
    try {
      savePayload.current ??= {
        requestId: requestId.current,
        verificationId: verification.verificationId,
        groupSelections: groups,
        agentSelections: agents.map((row) => ({
          ...row,
          permissionGroupIds: selectedGroupIds,
        })),
      };
      const result = (await props.onCommand(
        "saveVerifiedConnection",
        savePayload.current,
      )) as
        { connectionId: string } | { state: "review_required"; reason: string };
      if ("state" in result && result.state === "review_required") {
        savePayload.current = null;
        setSaveAttempted(false);
        setReviewRequired(true);
        setError(result.reason.slice(0, 800));
        return;
      }
      if (!("connectionId" in result)) throw new Error("Missing save result.");
      if (!result.connectionId) throw new Error("Missing save result.");
      committed.current = true;
      setSavedConnectionId(result.connectionId);
      props.onNotify("Service connection and selected access saved.");
      props.onComplete?.(result.connectionId);
    } catch {
      setError(
        "Save could not be confirmed. Retry the same save to check its outcome without creating a duplicate connection. Your review is retained.",
      );
    } finally {
      setBusy(null);
    }
  }

  const capabilityName = (capabilityId: string) =>
    verification?.capabilities.find((row) => row.id === capabilityId)
      ?.upstreamName ?? capabilityId;
  const connectionId = verification?.connectionId;
  const affectedAgents = snapshot.agents.filter((agent) => {
    const selected = agents.some((row) => row.agentId === agent.id);
    return (
      selected ||
      (connectionId &&
        agent.access.serviceConnectionIds.includes(connectionId) &&
        agent.access.permissionGroupIds.some((groupId) =>
          selectedGroupIds.includes(groupId),
        ))
    );
  });

  if (savedConnectionId)
    return (
      <section className="space-y-4 py-6">
        <h2 className="text-base font-semibold">Service connection saved</h2>
        <p role="status" className="text-sm">
          The reviewed connection and access are saved.
        </p>
        <Button onClick={props.onCancel}>Done</Button>
      </section>
    );

  return (
    <section aria-labelledby={`${id}-title`} className="min-w-0 space-y-5 py-6">
      <div className="space-y-2">
        <h2 id={`${id}-title`} className="text-base font-semibold">
          Connect a service
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Choose the account Crew should use and the access its agents should
          have.
        </p>
        <ol
          aria-label="Connection setup progress"
          className="flex flex-wrap gap-x-4 gap-y-2 text-xs"
        >
          {steps.map((label, index) => (
            <li
              key={label}
              aria-current={step === index ? "step" : undefined}
              className={
                step === index
                  ? "font-semibold text-primary"
                  : "text-muted-foreground"
              }
            >
              {index + 1}. {label}
            </li>
          ))}
        </ol>
      </div>

      {step === 0 && (
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`${id}-service`}>Service or saved connection</Label>
            <NativeSelect
              id={`${id}-service`}
              className="w-full"
              value={selection}
              onChange={(event) => {
                const next = event.target.value;
                const saved = snapshot.connections.find(
                  (row) => `existing:${row.id}` === next,
                );
                setSelection(next);
                setExistingRevision(saved?.revision ?? null);
                setName(saved?.name ?? "");
                setAccountKind("");
                setCredential("");
                setError("");
              }}
            >
              <option value="">Choose a service</option>
              <optgroup label="New connection">
                {snapshot.setupChoices
                  .filter(
                    (row) =>
                      row.guide && row.authenticationMethods.includes("token"),
                  )
                  .map((row) => (
                    <option key={row.id} value={`new:${row.id}`}>
                      {row.label}
                    </option>
                  ))}
              </optgroup>
              {snapshot.connections.length > 0 && (
                <optgroup label="Use a connection already saved in Crew">
                  {snapshot.connections.map((row) => (
                    <option key={row.id} value={`existing:${row.id}`}>
                      {row.name} · {row.identity.displayName}
                    </option>
                  ))}
                </optgroup>
              )}
            </NativeSelect>
          </div>
          {selection && !choice && (
            <p role="alert" className="text-sm text-destructive">
              The adapter for this connection is unavailable. Choose another
              connection or use its advanced Settings editor.
            </p>
          )}
          <p className="text-sm leading-6 text-muted-foreground">
            Connections are optional. Local work can continue without adding a
            service. Model subscription sign-in is managed separately.
          </p>
        </div>
      )}

      {step === 1 && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-sm font-medium">
            Which account should Crew use?
          </legend>
          {(["personal", "dedicated"] as const).map((kind) => (
            <label key={kind} className="flex items-start gap-3 py-2 text-sm">
              <input
                type="radio"
                name={`${id}-account`}
                value={kind}
                checked={accountKind === kind}
                onChange={() => setAccountKind(kind)}
                className="mt-1 size-4 accent-primary"
              />
              <span>
                <span className="font-medium">
                  {kind === "personal"
                    ? "My personal account"
                    : "A dedicated agent account"}
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  {guide?.accountOwnership[kind] ??
                    (kind === "personal"
                      ? "I explicitly choose to let Crew use my own account through this saved connection."
                      : "I choose the separate account my organization intends Crew to use.")}
                </span>
              </span>
            </label>
          ))}
          <p className="text-xs leading-5 text-muted-foreground">
            This records your intended account choice. Verification identifies
            the account where the provider supports it. Crew does not import
            browser sessions or personal Codex service credentials.
          </p>
        </fieldset>
      )}

      {step === 2 && (
        <div className="space-y-5">
          {!verification && (
            <fieldset disabled={busy !== null} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor={`${id}-name`}>Connection name</Label>
                <Input
                  id={`${id}-name`}
                  value={name}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={choice?.label}
                />
              </div>
              {existing ? (
                <p className="text-sm leading-6">
                  Verify the saved connection <strong>{existing.name}</strong>{" "}
                  using the credential already held by Crew. This does not
                  import access from another application.
                </p>
              ) : (
                <>
                  {guide && (
                    <div className="space-y-3 text-sm leading-6">
                      <ol className="list-decimal space-y-2 pl-5">
                        {guide.steps.map((text) => (
                          <li key={text}>{text}</li>
                        ))}
                      </ol>
                      <div className="flex flex-wrap gap-4">
                        <WebLink href={guide.credentialUrl}>
                          Create or manage the token
                        </WebLink>
                        <WebLink href={guide.documentationUrl}>
                          Provider instructions
                        </WebLink>
                      </div>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor={`${id}-credential`}>
                      {guide?.credentialLabel ?? "Service token"}
                    </Label>
                    <Input
                      id={`${id}-credential`}
                      type="password"
                      name="private-service-credential"
                      autoComplete="new-password"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      maxLength={65536}
                      value={credential}
                      onChange={(event) => setCredential(event.target.value)}
                    />
                    <p className="text-xs leading-5 text-muted-foreground">
                      The token is cleared from this field when you verify or
                      cancel. It is kept private by Crew and is never included
                      in agent instructions.
                    </p>
                  </div>
                </>
              )}
            </fieldset>
          )}
          {!verification ? (
            <Button
              disabled={
                busy !== null ||
                !name.trim() ||
                (!existing && !credential) ||
                connectionConflict
              }
              onClick={() => void verify()}
            >
              {busy === "verify"
                ? "Verifying account and operations…"
                : "Verify connection"}
            </Button>
          ) : (
            <div className="space-y-3 border-y py-4">
              <p role="status" className="text-sm font-medium">
                Connection verified
              </p>
              <p className="text-sm">
                {verification.identityStatus === "verified" &&
                verification.identity ? (
                  <>
                    Account:{" "}
                    <strong>{verification.identity.displayName}</strong>
                    {verification.identity.emailAddress
                      ? ` · ${verification.identity.emailAddress}`
                      : ""}
                  </>
                ) : (
                  "The provider did not return a verified account identity. Account identity is unavailable."
                )}
              </p>
              <p className="text-sm text-muted-foreground">
                {verification.capabilities.length} available operations
                discovered. Discovery does not guarantee access to every
                provider resource.
              </p>
              {!verification.capabilities.length && (
                <p className="text-sm text-muted-foreground">
                  No operations were returned. You can save this connection
                  without granting agent access.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {step === 3 && verification && (
        <div className="space-y-5">
          <fieldset
            disabled={saveAttempted || busy !== null}
            className="space-y-4"
          >
            <legend className="mb-2 text-sm font-medium">
              Group permissions
            </legend>
            <p className="text-sm leading-6 text-muted-foreground">
              Choose operations to add to existing groups. Each grant applies to
              all current and future group members who have this connection.
              Existing grants remain in place.
            </p>
            {!snapshot.groups.length && (
              <p className="text-sm text-muted-foreground">
                No permission groups exist yet. Save the connection privately,
                then create groups in Access settings.
              </p>
            )}
            {snapshot.groups.map((group) => {
              const selected = groups.find((row) => row.groupId === group.id);
              const existingCapabilities =
                group.grants.services.find(
                  (row) => row.connectionId === connectionId,
                )?.capabilities ?? [];
              return (
                <div key={group.id} className="space-y-2 border-t pt-3">
                  <Choice
                    checked={!!selected}
                    onChange={(checked) =>
                      setGroups((current) =>
                        checked
                          ? [
                              ...current,
                              {
                                groupId: group.id,
                                expectedRevision: group.revision,
                                capabilityIds: [],
                              },
                            ]
                          : current.filter((row) => row.groupId !== group.id),
                      )
                    }
                    description={group.description}
                  >
                    {group.name}
                  </Choice>
                  {selected && (
                    <div className="ml-7 space-y-1">
                      {verification.capabilities.map((capability) => (
                        <Choice
                          key={capability.id}
                          checked={
                            existingCapabilities.includes(capability.id) ||
                            selected.capabilityIds.includes(capability.id)
                          }
                          disabled={existingCapabilities.includes(
                            capability.id,
                          )}
                          onChange={(checked) =>
                            setGroups((current) =>
                              current.map((row) =>
                                row.groupId === group.id
                                  ? {
                                      ...row,
                                      capabilityIds: checked
                                        ? [...row.capabilityIds, capability.id]
                                        : row.capabilityIds.filter(
                                            (value) => value !== capability.id,
                                          ),
                                    }
                                  : row,
                              ),
                            )
                          }
                          description={
                            existingCapabilities.includes(capability.id)
                              ? "Already granted to this group."
                              : capability.description
                          }
                        >
                          {capability.upstreamName}
                        </Choice>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </fieldset>
          <fieldset
            disabled={saveAttempted || busy !== null}
            className="space-y-3 border-t pt-4"
          >
            <legend className="mb-2 text-sm font-medium">
              Agents using this connection
            </legend>
            <p className="text-sm leading-6 text-muted-foreground">
              Selected agents receive this connection and join the selected
              groups. Their other memberships and connections stay in place. A
              connection alone grants no operations.
            </p>
            {!snapshot.agents.length && (
              <p className="text-sm text-muted-foreground">
                No agents exist yet. You can assign this connection during agent
                setup later.
              </p>
            )}
            {snapshot.agents.map((agent) => (
              <Choice
                key={agent.id}
                checked={agents.some((row) => row.agentId === agent.id)}
                onChange={(checked) =>
                  setAgents((current) =>
                    checked
                      ? [
                          ...current,
                          {
                            agentId: agent.id,
                            expectedRevision:
                              snapshot.assignments.find(
                                (row) => row.agentId === agent.id,
                              )?.revision ?? null,
                            permissionGroupIds: [],
                          },
                        ]
                      : current.filter((row) => row.agentId !== agent.id),
                  )
                }
              >
                {agent.profile.name}
              </Choice>
            ))}
          </fieldset>
        </div>
      )}

      {step === 4 && verification && (
        <div className="space-y-5 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-3">
            <dt className="text-muted-foreground">Service</dt>
            <dd>{choice?.label}</dd>
            <dt className="text-muted-foreground">Connection</dt>
            <dd className="break-words">{verification.name}</dd>
            <dt className="text-muted-foreground">Account choice</dt>
            <dd>
              {verification.accountKind === "personal"
                ? "My personal account"
                : "Dedicated agent account"}
            </dd>
            <dt className="text-muted-foreground">Verified account</dt>
            <dd className="break-words">
              {verification.identityStatus === "verified" &&
              verification.identity
                ? verification.identity.displayName
                : "Identity unavailable from this provider"}
            </dd>
          </dl>
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">Group access after saving</h3>
            {!groups.length && (
              <p className="text-muted-foreground">
                No group permissions will be added.
              </p>
            )}
            {groups.map((selected) => {
              const group = snapshot.groups.find(
                (row) => row.id === selected.groupId,
              );
              const ids = [
                ...new Set([
                  ...(group?.grants.services.find(
                    (row) => row.connectionId === connectionId,
                  )?.capabilities ?? []),
                  ...selected.capabilityIds,
                ]),
              ];
              return (
                <div key={selected.groupId}>
                  <p className="font-medium">
                    {group?.name ?? "Unavailable group"}
                  </p>
                  <p className="break-words text-muted-foreground">
                    {ids.length
                      ? ids.map(capabilityName).join(", ")
                      : "No operations granted"}
                  </p>
                </div>
              );
            })}
            {groups.length > 0 && (
              <p className="text-xs leading-5 text-muted-foreground">
                These shared grants apply to all current and future members who
                have the connection.
              </p>
            )}
          </div>
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-medium">Agent access after saving</h3>
            {!affectedAgents.length && (
              <p className="text-muted-foreground">
                No agent assignments will change. Other existing access remains
                unchanged.
              </p>
            )}
            {affectedAgents.map((agent) => {
              const selected = agents.some((row) => row.agentId === agent.id);
              const joinedGroups = selected
                ? snapshot.groups.filter(
                    (group) =>
                      selectedGroupIds.includes(group.id) &&
                      !agent.access.permissionGroupIds.includes(group.id),
                  )
                : [];
              const memberships = [
                ...new Set([
                  ...agent.access.permissionGroupIds,
                  ...(selected ? selectedGroupIds : []),
                ]),
              ];
              const ids = [
                ...new Set(
                  snapshot.groups
                    .filter((row) => memberships.includes(row.id))
                    .flatMap((group) => [
                      ...(group.grants.services.find(
                        (row) => row.connectionId === connectionId,
                      )?.capabilities ?? []),
                      ...(groups.find((row) => row.groupId === group.id)
                        ?.capabilityIds ?? []),
                    ]),
                ),
              ];
              return (
                <div key={agent.id}>
                  <p className="font-medium">
                    {agent.profile.name}
                    {!selected ? " · existing member" : ""}
                  </p>
                  <p className="break-words text-muted-foreground">
                    {ids.length
                      ? ids.map(capabilityName).join(", ")
                      : "Connection assigned; no group operations granted"}
                  </p>
                  {joinedGroups.map((group) => (
                    <div
                      key={group.id}
                      className="mt-2 space-y-1 text-xs leading-5 text-muted-foreground"
                    >
                      <p>
                        Joining {group.name} also adds its existing permissions:
                      </p>
                      <p>
                        Crew actions:{" "}
                        {group.grants.crew.length
                          ? group.grants.crew
                              .map((grant) => grant.action)
                              .join("; ")
                          : "none"}
                        .
                      </p>
                      <p>
                        Approved workspaces:{" "}
                        {group.grants.environmentPolicyIds.length
                          ? group.grants.environmentPolicyIds.join(", ")
                          : "none"}
                        .
                      </p>
                      <p>
                        Other service capabilities:{" "}
                        {group.grants.services
                          .filter(
                            (grant) => grant.connectionId !== connectionId,
                          )
                          .reduce(
                            (total, grant) => total + grant.capabilities.length,
                            0,
                          )}
                        . These apply where the agent also has the corresponding
                        connection.
                      </p>
                    </div>
                  ))}
                </div>
              );
            })}
            <p className="text-xs leading-5 text-muted-foreground">
              Existing explicit approval grants remain independent. This review
              describes group access; every operation still checks current
              authorization.
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              An active agent may need an explicit Restart to refresh its
              available service tools. Saving does not start or restart agents.
            </p>
          </div>
        </div>
      )}

      {connectionConflict && (
        <p role="alert" className="text-sm text-destructive">
          This saved connection changed. Your draft is retained. Cancel and
          choose its current version before verifying again.
        </p>
      )}
      {(accessConflict || reviewRequired) && (
        <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">
            Saved group or agent access changed while you were reviewing. Your
            selections are retained. Review the current access before saving.
          </p>
          {!saveAttempted && (
            <Button variant="outline" onClick={refreshAccessReview}>
              Review current access
            </Button>
          )}
        </div>
      )}
      {expired && (
        <p role="alert" className="text-sm text-destructive">
          This verification expired. Cancel and verify the connection again
          before saving.
        </p>
      )}
      <ErrorMessage>{error}</ErrorMessage>
      <div className="flex flex-wrap justify-between gap-3 border-t pt-4">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            disabled={busy === "save" || busy === "cancel" || saveAttempted}
            onClick={() => void leave()}
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel"}
          </Button>
          {props.onSkip && step === 0 && (
            <Button
              variant="ghost"
              disabled={busy !== null}
              onClick={() => void leave(true)}
            >
              Skip for now
            </Button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {step > 0 && !saveAttempted && (
            <Button
              variant="outline"
              disabled={busy !== null}
              onClick={() => void back()}
            >
              Back
            </Button>
          )}
          {step < 4 ? (
            <Button
              disabled={
                busy !== null ||
                connectionConflict ||
                (step === 0 && !choice) ||
                (step === 1 && !accountKind) ||
                (step === 2 && !verification) ||
                (step === 3 && accessConflict) ||
                expired
              }
              onClick={() => {
                setError("");
                setStep(step + 1);
              }}
            >
              {step === 3 ? "Review connection" : "Continue"}
            </Button>
          ) : (
            <Button
              disabled={
                busy !== null ||
                (!saveAttempted &&
                  (accessConflict || connectionConflict || expired))
              }
              onClick={() => void save()}
            >
              {busy === "save"
                ? "Saving…"
                : saveAttempted
                  ? "Retry save"
                  : existing
                    ? "Save access"
                    : "Save connection"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
