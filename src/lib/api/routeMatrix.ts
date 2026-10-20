import { invoke } from "@tauri-apps/api/core";

export interface MatrixPolicy {
  maxRetries: number;
  firstByteTimeout: number;
  idleTimeout: number;
  requestTimeout: number;
  failureThreshold: number;
  cooldownSeconds: number;
}
export interface MatrixModel {
  id: string;
  activeProviderId?: string;
  targets: { providerId: string; model: string }[];
  catalog: Record<string, unknown>;
}
export interface MatrixRoute {
  id: string;
  name: string;
  prefix: string;
  /** Explicit route membership; omitted in earlier configurations. */
  providerIds?: string[];
  activeProviderId: string;
  failover: boolean;
  policy: MatrixPolicy;
  models: MatrixModel[];
}
export interface MatrixConfig {
  version: number;
  enabled: boolean;
  primary: MatrixRoute;
  secondary: MatrixRoute[];
}
export const matrixPolicy = (): MatrixPolicy => ({
  maxRetries: 2,
  firstByteTimeout: 60,
  idleTimeout: 120,
  requestTimeout: 120,
  failureThreshold: 3,
  cooldownSeconds: 60,
});
export const routeMatrixApi = {
  get: () => invoke<MatrixConfig>("get_route_matrix"),
  save: (config: MatrixConfig) => invoke<void>("save_route_matrix", { config }),
  connect: (enabled: boolean) =>
    invoke<void>("connect_route_matrix", { enabled }),
};
