// 应用外壳（英文）。
import type { Messages } from "../zh";

const app: Messages["app"] = {
  notFound: {
    pageTitle: "Project not found · Paperloom",
    heading: (id) => `Project “${id}” not found`,
    needsMigration: "The data folder still uses the old layout. Until it is migrated, only the original project can be opened.",
    maybeDeleted: "It may have been deleted, or it was created in another browser (without the local service).",
    localDataLeft: "This browser still has data for this project.",
    exportLocal: "Export this project's data from this browser (JSON)",
    exported: (file) => `Downloaded ${file}. You can import it in any project under “Data & backup”.`,
    localEmpty: "This project's database in this browser is empty",
    exportFailed: (reason) => `Export failed: ${reason}`,
    open: (name) => `Open “${name}”`,
  },
};

export default app;
