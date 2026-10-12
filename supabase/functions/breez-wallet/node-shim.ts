// Runs the payment-service's Node-style handler (app.handle(req, res)) on a
// fetch Request, so the Edge Function serves exactly the same contract.

export type NodeLikeReq = {
  method: string;
  url: string;
  headers: Record<string, string>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
};

export function toNodeRequest(method: string, pathAndQuery: string, headers: Headers, body: Uint8Array): NodeLikeReq {
  const h: Record<string, string> = {};
  headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return {
    method,
    url: pathAndQuery,
    headers: h,
    async *[Symbol.asyncIterator]() { if (body.length) yield body; },
  };
}

export function captureResponse(): { res: unknown; done: Promise<Response> } {
  let resolve!: (r: Response) => void;
  const done = new Promise<Response>((r) => { resolve = r; });
  let status = 200;
  let hdrs: Record<string, string> = {};
  const res = {
    writeHead(s: number, h: Record<string, string>) { status = s; hdrs = { ...h }; delete hdrs.connection; },
    end(text: string) { resolve(new Response(text, { status, headers: hdrs })); },
  };
  return { res, done };
}
