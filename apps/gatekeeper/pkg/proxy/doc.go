// Package proxy is the gatekeeper's data plane: the listeners that carry
// traffic, and the admission decision in front of each of them.
//
// One [Supervisor] owns one listener per configured endpoint. A request
// reaching a listener is forwarded only if that endpoint holds a verdict that
// admits it (ADR-003 §1: the whole attestation pipeline, then every Rego
// package). Without one the endpoint answers 503 — or, when the user opted into
// `failMode: open`, forwards anyway and says so on the way back.
//
// Three properties are the reason this package exists rather than a plain
// [httputil.ReverseProxy]:
//
//   - The verdict is bound to a certificate, not to a hostname. Verification
//     observes the TLS leaf on its own dedicated handshake, and every proxied
//     connection is held to that same leaf: a pool that presents a different
//     certificate is refused, whatever the last verdict said.
//   - Nothing about the verdict is ever sent upstream. `X-Gatekeeper-*` request
//     headers are stripped, and the verdict header is written on the way back to
//     the local client only (ADR-003 §6).
//   - Streaming is not buffered. Responses are flushed per write, so
//     `text/event-stream` reaches the client chunk by chunk, and WebSocket
//     upgrades and long-lived requests pass through.
//
// [Supervisor] implements [status.Supervisor] and [status.Reloader], which is
// what `gatekeeper run`, `gatekeeper status` and the dashboard are written
// against. Its state is also readable out of process over the optional admin
// socket (`admin.listen`): /healthz, /status, /endpoints, /verdicts and
// /metrics.
package proxy
