import type { SetupProps } from "../contracts/setup.js";

import {
  Actions,
  CheckList,
  Hint,
  Panel,
  SetupButton,
  ToolsCheck,
} from "./components.js";

export function AccountStep({ setup }: SetupProps) {
  const { snapshot } = setup;
  return (
    <Panel
      data-step="2"
      title="Use your ChatGPT sign-in"
      description="Crew checks your existing ChatGPT sign-in and available voices. No voice call or worker starts."
    >
      <p className="text-sm leading-relaxed">
        If needed, <strong>Sign in with ChatGPT</strong> opens the normal
        browser sign-in. Crew never asks for an API key or displays
        authentication tokens.
      </p>
      <Actions>
        <SetupButton
          id="account"
          variant="default"
          onClick={() =>
            setup.check("account", "Check sign-in and capabilities")
          }
        >
          Check sign-in and capabilities
        </SetupButton>
        <SetupButton
          id="login"
          onClick={() =>
            setup.check("login", "Sign in with ChatGPT in your browser")
          }
        >
          Sign in with ChatGPT
        </SetupButton>
      </Actions>
      <CheckList
        id="account-result"
        snapshot={snapshot}
        entries={[
          ["protocol", "Protocol"],
          ["auth", "ChatGPT"],
          ["voices", "Voice catalog"],
        ]}
      />
      <section className="space-y-3" aria-labelledby="tools-heading">
        <h3 id="tools-heading" className="font-semibold">
          Connected tools
        </h3>
        <Hint>
          Crew uses your connected Linear tools to find teams and projects in
          the next step. Before work starts, the manager checks the actual
          ticket.
        </Hint>
        <ToolsCheck snapshot={snapshot} />
      </section>
    </Panel>
  );
}
