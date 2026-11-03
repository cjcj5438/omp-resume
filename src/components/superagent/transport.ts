/**
 * Superagent 面板的 IPC 传输：把面板的 HTTP 请求经 `superagent_request`
 * 代理到守护进程的 unix socket。守护进程不可用时抛 `TransportUnavailable`，
 * 面板据此显示离线态而非崩溃。
 */
import type { Transport } from "omp-superagent/panel";
import { TransportUnavailable } from "omp-superagent/panel";
import { normalizeError, superagentRequest } from "../../api";
import type { SuperagentHttpMethod } from "../../types";

export const invokeTransport: Transport = async (method, path, body) => {
  try {
    const r = await superagentRequest(method as SuperagentHttpMethod, path, body);
    return { status: r.status, text: r.body };
  } catch (e) {
    const err = normalizeError(e);
    if (err.code === "SUPERAGENT_UNAVAILABLE") throw new TransportUnavailable(err.message);
    throw err;
  }
};
