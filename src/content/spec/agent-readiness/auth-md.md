---
title: "auth.md — agent registration instructions"
slug: auth-md
category: agent-readiness
summary: "An auth.md file tells agents how to register with a service and obtain scoped API access. An emerging convention for services that support agent registration, backed by OAuth metadata and server-enforced permissions."
status: optional
order: 46
appliesTo: [all]
relatedSlugs: [agent-readiness-overview, oauth-protected-resource, oauth-authorization-server, web-bot-auth]
updated: "2026-09-30T00:00:00.000Z"
sources:
  - title: "WorkOS — The auth.md file"
    url: "https://workos.com/auth-md/docs/auth-md"
    publisher: "WorkOS"
  - title: "auth.md — protocol and reference implementation"
    url: "https://github.com/workos/auth.md"
    publisher: "WorkOS"
  - title: "RFC 9728 — OAuth 2.0 Protected Resource Metadata"
    url: "https://www.rfc-editor.org/rfc/rfc9728"
    publisher: "IETF"
  - title: "RFC 9700 — Best Current Practice for OAuth 2.0 Security"
    url: "https://www.rfc-editor.org/rfc/rfc9700.html"
    publisher: "IETF"
---

## What it is

`auth.md` is a public Markdown document at a service's root, such as `https://example.com/auth.md`, describing how an agent registers and obtains API access. It is an emerging, WorkOS-authored open convention with a reference implementation, rather than an IETF standard. Its OAuth building blocks are standards; its `agent_auth` metadata extension and claim grant are specific to this protocol.

The file documents a registration system. Publishing Markdown alone does not create accounts, authenticate users, or grant permission. [OAuth protected resource metadata](/spec/well-known/oauth-protected-resource/) identifies the API and its authorisation servers; [authorisation server metadata](/spec/well-known/oauth-authorization-server/) provides the endpoints. The prose guides an agent through those services.

This site does not publish auth.md: its public content and MCP endpoint do not require user registration or delegated access.

## Why it matters

For a service that accepts agent registrations, a discoverable procedure can reduce reliance on an agent navigating a human sign-up form. The service still decides which identities to trust and which actions to permit.

Keep this optional. A public information site has no registration workflow to describe, and a service with an existing OAuth integration should assess whether this emerging protocol adds value for its clients.

## How to implement

Serve public Markdown over HTTPS at `/auth.md`, without a login wall. Link to it from integration documentation and the protocol's `agent_auth.skill` metadata field. Keep its hostnames, scopes, request examples, errors, and renewal instructions aligned with the deployed API.

Organise the file as a walkthrough: discover OAuth metadata, choose a supported registration method, register, complete any user claim, exchange the assertion, call the API, and handle revocation. Endpoint URLs should come from metadata rather than guesses based on example paths.

The reference implementation supports provider-issued identity assertions, an email-based flow requiring user confirmation, and anonymous registration with restricted access before a user claims it. Describe only the methods your service implements. Its claim ceremony resembles OAuth device authorisation, but uses a protocol-specific grant; a generic device-flow client cannot be assumed compatible.

### Security boundaries

Treat the Markdown as documentation. Enforce permissions at the API, with audience-restricted tokens and the minimum scopes needed, following [OAuth security best practice](https://www.rfc-editor.org/rfc/rfc9700.html).

For identity assertions, validate signatures, trusted issuers, audience, expiry, authentication freshness, and replay protection. The reference template requires user consent before asserting their identity and confirmation before linking an unfamiliar provider identity to an existing account. An email address supplied by an agent is not proof of account ownership.

For user claims, show the user which service and permissions they are authorising. Have them authenticate and enter the code on the service's own page. Restrict anonymous access and enforce code expiry and attempt limits server-side.

Keep tokens and assertions out of the public file, URLs, and logs. Verify that revocation prevents continued access, including obtaining new tokens from an earlier assertion.

## Common mistakes

- Publishing the file before implementing its registration endpoints.
- Describing WorkOS-specific extensions as requirements of an OAuth RFC.
- Treating a provider identity as permission for every action.
- Confusing registration on behalf of a user with [Web Bot Auth](/spec/agent-readiness/web-bot-auth/), which verifies the identity of automated HTTP traffic.

## Verification

Fetch `/auth.md` without credentials and confirm it returns readable Markdown rather than a login page. Compare every documented endpoint and scope with live metadata.

In a test environment, complete each supported method and check that unsupported methods fail. Try an untrusted assertion issuer, wrong audience, expired claim code, and access outside the granted scopes. Revoke the registration and confirm both API access and further token issuance fail. A successful file fetch verifies discovery only; these checks verify the workflow it describes.
