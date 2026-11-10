# Mizan — Architecture and Product Decision Log

Decisions apply to the isolated development copy; they do not authorize production deployment.

| ID | Status | Decision | Reason and implications |
|---|---|---|---|
| D-001 | Accepted | The 39-file Sprint 6 ZIP is the **verified development starting point** for Sprints 7–12. | SHA-256 and byte comparison confirm identity. GitHub HEAD `671ebcc` is a separate checkout; never silently substitute it. |
| D-002 | Accepted | No deployment or remote D1/Cloudflare changes without separate approval. | Existing Wrangler and GitHub Actions include production deployment paths. |
| D-003 | Accepted | Any completion report must cite a real commit and test log, with untested scopes plainly marked. | Model memory and chat summaries are not durable evidence. |
| D-004 | Accepted | Continue Sprints 7–12 in sequence, include tests per sprint, deliver paired reports after 8/10/12. | User approved roadmap; sprint scope can change only with an explicit log update. |
| D-005 | Architectural direction | Bring Your Own Number (BYON), support customers' existing numbers via SIP/PBX or permitted forwarding. | No Mizan phone-number provisioning as a requirement. Not all line types offer the same connectivity. |
| D-006 | Architectural direction | Separate telephony/PBX gateway from Cloudflare Worker; start with an isolated lab proof of concept and an adapter boundary. | Workers are not a general-purpose SIP/RTP UDP endpoint; vendor-independent design is preferable. |
| D-007 | Pending implementation | Keep sensitive caller audio/phone and tenant identifiers out of routine diagnostics. | Privacy/retention and licensing need verification before real calls. |
| D-008 | Pending validation | Staging deploy must be fully isolated (resource IDs/domains/secrets/CI paths) and reversible. | No implicit production-side operations, even while diagnosing build failures. |

| D-009 | Accepted | Release remains **NO-GO** until separate isolated staging, real voice/PBX, dependency build and payment/privacy gates have auditable evidence. | Local regressions are not an operational readiness guarantee. |
| D-010 | Accepted | Offer only read-only estimated usage in the portal; no approved prices or payment activation. | Avoid misleading billing claims or unapproved charges. |
| D-011 | Accepted | Treat the telephony codec/routing components as a lab-only BYON adapter, not as a working SIP trunk. | Requires separate authenticated signalling/media gateway and permitted carrier provisioning. |

## Known conflicts to resolve

`README.md` describes Workers AI Flux/TTS without external keys, but the source/test snapshot contains external Deepgram and ElevenLabs integrations. Until source and live configuration are verified, treat README descriptions as **historical**, not evidence of the running environment. Do not overwrite real deploy configuration based on README alone.

## Decision change process

Append a new dated decision or supersede an ID with rationale, code/tests affected, and the approving actor. Do not silently rewrite prior accepted decisions.

