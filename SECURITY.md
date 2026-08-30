# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Super-Protocol/confidential-router/security/advisories/new),
or by email to **security@superprotocol.com**.

Please include:

- the affected component (`gatekeeper`, `router-api`, `router-ui`, a library),
- the version or commit,
- reproduction steps or a proof of concept,
- the impact you believe it has.

We aim to acknowledge a report within **3 business days** and to provide a
remediation plan within **10 business days**. We will credit reporters in the
release notes unless you ask us not to.

## Scope

This project's security boundary is the **attestation and admission path**.
Findings we are especially interested in:

- Any way to make the Gatekeeper admit traffic to an endpoint whose evidence
  does not verify — broken certificate-chain validation, JWS signature or
  algorithm confusion, missing freshness checks, or a channel-binding bypass
  (`payload.certFingerprint` vs. the observed TLS leaf).
- Any way to make a Rego policy evaluate to `allow` when a loaded policy should
  have denied, or to bypass the requirement that **every** loaded policy allows.
- Any path that turns a fail-closed endpoint into a fail-open one without the
  operator opting in.
- Leakage of prompt content or API keys through logs, metrics or error bodies.

Out of scope: findings that require an attacker to already control the user's
machine or the gatekeeper configuration file, and denial of service against a
local gatekeeper by its own operator.

## Supported versions

The project is pre-release; only `main` is supported. Once releases begin, this
section will list the supported release lines.
