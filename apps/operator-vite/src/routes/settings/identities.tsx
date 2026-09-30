import { createFileRoute } from "@tanstack/react-router";
import Page from "@/app/settings/identities/page";

/** /settings/identities — installed identity library and live activation truth. */
export const Route = createFileRoute("/settings/identities")({
  component: Page,
});
