import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AutoFailoverConfigPanel } from "@/components/proxy/AutoFailoverConfigPanel";

const mock = vi.hoisted(() => ({
  save: vi.fn(),
  config: {
    enabled: true,
    autoFailoverEnabled: false,
    maxRetries: 2,
    streamingFirstByteTimeout: 60,
    streamingIdleTimeout: 120,
    nonStreamingTimeout: 600,
    circuitFailureThreshold: 3,
    circuitSuccessThreshold: 2,
    circuitTimeoutSeconds: 60,
    circuitErrorRateThreshold: 0.5,
    circuitMinRequests: 10,
  },
}));
vi.mock("@/lib/query/proxy", () => ({
  useAppProxyConfig: () => ({ data: mock.config, isLoading: false }),
  useUpdateAppProxyConfig: () => ({ mutateAsync: mock.save, isPending: false }),
}));
beforeEach(() => {
  mock.save.mockResolvedValue(undefined);
});
describe("shared policy fields in ordinary routing settings", () => {
  it("saves edited timeouts while retaining ordinary-route circuit and failover settings", async () => {
    render(<AutoFailoverConfigPanel appType="codex" />);
    fireEvent.change(screen.getByLabelText("流式首字节超时（秒）"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mock.save).toHaveBeenCalledWith({
        appType: "codex",
        enabled: true,
        autoFailoverEnabled: false,
        maxRetries: 2,
        streamingFirstByteTimeout: 90,
        streamingIdleTimeout: 120,
        nonStreamingTimeout: 600,
        circuitFailureThreshold: 3,
        circuitSuccessThreshold: 2,
        circuitTimeoutSeconds: 60,
        circuitErrorRateThreshold: 0.5,
        circuitMinRequests: 10,
      }),
    );
  });
  it("retains the ordinary route's original limits despite wider matrix limits", () => {
    render(<AutoFailoverConfigPanel appType="codex" />);
    fireEvent.change(screen.getByLabelText("最大重试次数"), {
      target: { value: "11" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(mock.save).not.toHaveBeenCalled();
  });
});
