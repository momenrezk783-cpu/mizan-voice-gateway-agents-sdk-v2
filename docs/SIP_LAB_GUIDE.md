# SIP / PBX laboratory integration — NOT a telephony deployment

## Commercial model

Bring Your Own Number: each client retains the existing phone number and line provider. The DID can be routed from its approved IP PBX via an authorized SIP trunk or forwarding policy; not all mobile/traditional lines support this. Carrier/provider permissions and Egyptian telecom requirements must be verified before production.

## Boundaries

```text
Business's existing number -> licensed provider or PBX -> authenticated external SIP/RTP gateway
  -> authenticated per-call route from trusted PBX + called destination
  -> media adapter: 8 kHz PCMU ↔ 16 kHz PCM
  -> Mizan voice pipeline (after separately building a secure media bridge)
```

- **Implemented:** pure `resolveTrustedPbxRoute` and `TelephonyLabSession` lab-only audio/event functions, tested with synthetic audio; isolated from production Worker.
- **Not implemented:** Asterisk or FreeSWITCH service, SIP REGISTER/INVITE negotiation, RTP/WebSocket bridge, WebSocket authentication, voice session provisioning, resampling quality filter, jitter buffers, DTMF, barge-in, transfers, recording consent, telecom-provider routing, concurrent call admission, alerts and real audio streaming.
- **Security:** Do not accept caller-provided `tenant_slug`, Caller-ID or unsanitized SIP headers as route authority. Production must authenticate the gateway (mTLS/JWT with audience/expiry/nonce/replay defense), bind the route to an authorized PBX identity, and enforce per-tenant capacity before session creation.
- **Privacy:** Do not log raw phone numbers or audio. Define retention and delete procedures, caller consent, country rules and incident handling before real traffic.

## Reproducible lab checks

```sh
node tests/telephony-lab.test.mjs
node tests/telephony-route.test.mjs
```

## Next hardware/third-party gate

Choose a permitted SIP provider or local test PBX, use an isolated test DID/extension (not an actual client number), implement an authenticated media gateway with explicit transport and negotiation, measure audio packet loss and turn latency, then test hold/transfer and rollback. No PSTN/PBX calls were run by the local tests.
