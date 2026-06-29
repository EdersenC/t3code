import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ThreadErrorBanner } from "./ThreadErrorBanner";

describe("ThreadErrorBanner", () => {
  it("keeps the error message in the alert description slot", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error="Ollama provider could not start." onDismiss={() => undefined} />,
    );

    expect(markup).toContain('data-slot="alert-description"');
    expect(markup).toContain("Ollama provider could not start.");
    expect(markup).toContain('aria-label="Dismiss error"');
    expect(markup).toMatch(
      /\[&amp;&gt;svg\]:size-full"><svg[\s\S]*?<\/svg><\/div><div class="flex min-w-0 flex-1 flex-col gap-0\.5"><div class="flex flex-col gap-2\.5 text-muted-foreground"/,
    );
  });
});
