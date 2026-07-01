import { createFileRoute } from "@tanstack/react-router";
import { WrenchIcon } from "lucide-react";

import { CapabilityCenter } from "../components/settings/CapabilityCenter";

function SettingsToolsRoute() {
  return <CapabilityCenter title="Subagent" icon={<WrenchIcon className="size-3.5" />} />;
}

export const Route = createFileRoute("/settings/tools")({
  component: SettingsToolsRoute,
});
