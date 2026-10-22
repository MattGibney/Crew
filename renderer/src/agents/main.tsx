import { createRoot } from "react-dom/client";
import "../styles/theme.css";
import { AgentsApp } from "./AgentsApp";
import { createAgentsHttpClient } from "./http-client";

const client = createAgentsHttpClient();
createRoot(document.getElementById("root")!).render(
  <AgentsApp client={client} />,
);
