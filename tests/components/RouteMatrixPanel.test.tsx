import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../utils/testQueryClient";
import { RouteMatrixPanel } from "@/components/route-matrix/RouteMatrixPanel";
import {
  matrixPolicy,
  routeMatrixApi,
  type MatrixConfig,
} from "@/lib/api/routeMatrix";

vi.mock("@/lib/api/routeMatrix", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/api/routeMatrix")>();
  return {
    ...original,
    routeMatrixApi: { get: vi.fn(), save: vi.fn(), connect: vi.fn() },
  };
});
const providers = {
  a: { id: "a", name: "账号 A", settingsConfig: {} },
  b: { id: "b", name: "账号 B", settingsConfig: {} },
};
let config: MatrixConfig;
beforeEach(() => {
  config = {
    version: 1,
    enabled: false,
    primary: {
      id: "main",
      name: "主路由",
      prefix: "",
      activeProviderId: "a",
      failover: false,
      policy: matrixPolicy(),
      models: [
        {
          id: "gpt-test",
          targets: [
            { providerId: "a", model: "actual-a" },
            { providerId: "b", model: "actual-b" },
          ],
          catalog: {},
        },
      ],
    },
    secondary: [],
  };
  vi.mocked(routeMatrixApi.get).mockImplementation(async () =>
    structuredClone(config),
  );
  vi.mocked(routeMatrixApi.save).mockImplementation(async (next) => {
    config = structuredClone(next);
  });
  vi.mocked(routeMatrixApi.connect).mockResolvedValue();
});
async function open() {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <RouteMatrixPanel providers={providers} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "配置连接" }));
  await screen.findByRole("region", { name: "主路由" });
}
describe("Route Matrix", () => {
  it("saves manual account switching without reconnecting Codex", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("当前供应商"), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(routeMatrixApi.save).toHaveBeenCalled());
    expect(config.primary.activeProviderId).toBe("b");
    expect(routeMatrixApi.connect).not.toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent(
      "后续请求使用新配置",
    );
  });
  it("adds a separate secondary route with its own failover policy", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "添加副路由" }));
    const secondary = screen.getAllByRole("region")[1];
    fireEvent.change(within(secondary).getByLabelText("模型前缀"), {
      target: { value: "backup" },
    });
    fireEvent.click(within(secondary).getByLabelText("自动故障转移"));
    fireEvent.change(within(secondary).getByLabelText("熔断冷却（秒）"), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(routeMatrixApi.save).toHaveBeenCalled());
    expect(config.secondary[0]).toMatchObject({
      prefix: "backup",
      failover: true,
      policy: { cooldownSeconds: 30 },
    });
    expect(config.primary.failover).toBe(false);
  });
  it("does not change the connection when saving fails", async () => {
    vi.mocked(routeMatrixApi.save).mockRejectedValueOnce("模型映射不完整");
    await open();
    fireEvent.click(screen.getByRole("button", { name: "保存并接入 Codex" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "模型映射不完整",
    );
    expect(routeMatrixApi.connect).not.toHaveBeenCalled();
  });
  it("can pin a primary model independently of the route selection", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("此模型的供应商"), {
      target: { value: "b" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    await waitFor(() => expect(routeMatrixApi.save).toHaveBeenCalled());
    expect(config.primary.activeProviderId).toBe("a");
    expect(config.primary.models[0].activeProviderId).toBe("b");
  });
  it("blocks saving invalid model capability JSON", async () => {
    await open();
    const input = screen.getByLabelText("模型能力参数");
    fireEvent.change(input, { target: { value: "{invalid" } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("请修正配置");
    expect(routeMatrixApi.save).not.toHaveBeenCalled();
  });
});
