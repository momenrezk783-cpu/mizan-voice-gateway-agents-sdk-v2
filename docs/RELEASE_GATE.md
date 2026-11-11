# Automated release gate

The previous CI gate checked for historical evidence filenames instead of using
successful CI checks. It also required SIP/PBX and payment verification for a
browser-only release, and an ignored staging configuration that was absent in CI.
This blocked deployment even when TypeScript, tests and the bundle had passed.

`npm run release:gate` now runs, in order:

1. `npm run typecheck`
2. `npm test`
3. `npm run bundle:check` (temporary isolated fixture bindings, dry-run only)

Any failed, interrupted or unstartable check stops the gate with a nonzero exit.
A file named after a successful check cannot substitute for actually running it.
The release-guard unit test imports the gate with a controlled command runner;
it does not recursively run the gate inside `npm test`.

GitHub's validation job runs this gate once on the checked-out commit. The
production job has `needs: validate`, so a failed validation cannot reach deploy.
The main-only restriction and existing production environment remain in place.
No deployment is triggered by the gate script itself.

## Integration scope

`release.config.json` declares the features included in a release. Both `sip` and
`billing` are false because this application currently offers browser voice calls
and read-only usage reporting, not a production SIP gateway or payment charging.
These declarations do not turn runtime integrations on or off.

When adding and enabling an integration, change its declaration and supply the
corresponding result from its real verification process:

- SIP: `docs/evidence/authorized-sip-pbx.json`
- Billing: `docs/evidence/billing-sandbox-verified.json`

The JSON must contain `feature` (`sip` or `billing`), `status: "passed"`, `revision`
(the full current Git commit SHA), and `verifiedAt` (ISO timestamp no older than
seven days). Generate this evidence for the checked-out commit as part of that
integration's verification process; a placeholder file or stale result is rejected.
Satisfying these metadata checks does not itself prove provider authorization,
regulatory compliance or correctness of an integration's test procedure.

## Limits of the result

A passing gate establishes automated code/test/bundle validation. It does not
claim that a live voice call was tested, that the accent is Egyptian, or that
production credentials, migrations and services are healthy. Staging configuration
validation is still available separately with `npm run staging:check` when using
real staging resources. Do not add fabricated live-test evidence to unblock CI.
