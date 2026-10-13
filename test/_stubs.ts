import { vi } from "vitest";

export interface StubbedCall {
  url: string;
  method: string;
  body: string;
  headers: Headers;
}

export interface FetchStub {
  calls: StubbedCall[];
  restore: () => void;
}

type Responder = (req: StubbedCall) => Response | Promise<Response>;

/**
 * Replace globalThis.fetch with a stub that records every outbound request and
 * answers via `responder`. Portable across runtimes; keeps all Moodle/Google
 * traffic in-process so no test touches the live site.
 */
export function stubFetch(responder: Responder): FetchStub {
  const calls: StubbedCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body = "";
    if (init?.body instanceof URLSearchParams) body = init.body.toString();
    else if (typeof init?.body === "string") body = init.body;
    const headers = new Headers(init?.headers ?? {});
    const call: StubbedCall = { url, method, body, headers };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Build a Moodle JSON web-service response (always HTTP 200). */
export function moodleJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
