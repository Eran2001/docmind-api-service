import { SetMetadata } from "@nestjs/common";

export const NO_DEMO = "noDemo";

/** Demo visitors get a 403 `DemoRestricted` here (changing the account, creating or deleting collections, running evals, ...). */
export const NoDemo = () => SetMetadata(NO_DEMO, true);
