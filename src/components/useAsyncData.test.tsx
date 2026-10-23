import { expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useAsyncData } from "./useAsyncData";

function Probe<T>({ loader, deps, opts }: {
  loader: () => Promise<T>;
  deps: unknown[];
  opts?: { enabled?: boolean; keepPrevious?: boolean };
}) {
  const r = useAsyncData(loader, deps, opts);
  return (
    <div>
      <span data-testid="data">{JSON.stringify(r.data)}</span>
      <span data-testid="loading">{String(r.loading)}</span>
      <span data-testid="error">{r.error ? r.error.message : ""}</span>
      <button type="button" onClick={r.reload}>reload</button>
    </div>
  );
}

it("乱序返回时只采纳最新请求", async () => {
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  let calls = 0;
  const loader = () => {
    calls += 1;
    return calls === 1 ? first.promise : second.promise;
  };
  const { rerender } = render(<Probe loader={loader} deps={[1]} />);
  rerender(<Probe loader={loader} deps={[2]} />);
  await act(async () => {
    second.resolve("新");
    await second.promise;
  });
  await act(async () => {
    first.resolve("旧");
    await first.promise;
  });
  expect(screen.getByTestId("data").textContent).toBe(JSON.stringify("新"));
  expect(screen.getByTestId("loading").textContent).toBe("false");
});

it("卸载后不再写状态", async () => {
  const onError = vi.spyOn(console, "error").mockImplementation(() => {});
  const gate = Promise.withResolvers<string>();
  const { unmount } = render(<Probe loader={() => gate.promise} deps={[]} />);
  unmount();
  await act(async () => {
    gate.resolve("迟到");
    await gate.promise;
  });
  expect(onError).not.toHaveBeenCalled();
  onError.mockRestore();
});

it("reload 会重新执行请求", async () => {
  let calls = 0;
  const loader = () => {
    calls += 1;
    return Promise.resolve(`第${calls}次`);
  };
  render(<Probe loader={loader} deps={[]} />);
  expect(await screen.findByText(JSON.stringify("第1次"))).toBeTruthy();
  await act(async () => {
    screen.getByRole("button", { name: "reload" }).click();
  });
  expect(await screen.findByText(JSON.stringify("第2次"))).toBeTruthy();
  expect(calls).toBe(2);
});
