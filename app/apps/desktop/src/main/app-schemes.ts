/** Privileged custom schemes; registered before app ready. */
import { DESIGN_SCHEME_PRIVILEGES } from "./design/paths.ts";

export const APP_SCHEMES = [
  {
    scheme: "zeno-theme",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  DESIGN_SCHEME_PRIVILEGES,
];
