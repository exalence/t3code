/**
 * Kiro's client definition: settings form, label, and glyph.
 * Browser- and React Native-safe.
 *
 * @module provider-kiro/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { KiroSettings } from "./settings.ts";

export const kiroClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("kiro"),
  label: "Kiro",
  settingsSchema: KiroSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#7C3AED", dark: "#A78BFA" },
    paths: [
      {
        // A ghost silhouette with two eyes cut out (even-odd fill).
        d: "M12 2C7.58 2 4 5.58 4 10v10.5c0 .83.95 1.3 1.6.8l1.4-1.05 1.4 1.05c.36.27.84.27 1.2 0L11 20.25l1.4 1.05c.36.27.84.27 1.2 0l1.4-1.05 1.4 1.05c.36.27.84.27 1.2 0l1.4-1.05V10c0-4.42-3.58-8-8-8Zm-3 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z",
        fillRule: "evenodd",
      },
    ],
  },
});
