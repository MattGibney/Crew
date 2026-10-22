/// <reference types="vite/client" />
import type { SetupBridge, WorkspaceBridge } from "./contracts/setup.js";
declare global {
  interface Window {
    crewWindow?: {
      integratedTitlebar?: boolean;
      copyText?: (text: string) => Promise<void>;
    };
    crewWorkspaces?: WorkspaceBridge;
    crewSetup?: SetupBridge;
  }
}
