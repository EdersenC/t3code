import { createFileRoute } from "@tanstack/react-router";

import { PersonalizationSettingsPanel } from "../components/settings/PersonalizationSettings";

function SettingsPersonalizationRoute() {
  return <PersonalizationSettingsPanel />;
}

export const Route = createFileRoute("/settings/personalization")({
  component: SettingsPersonalizationRoute,
});
