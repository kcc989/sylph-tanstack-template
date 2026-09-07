# Sylph release contract

This candidate implements resource planning and all five production release hooks. Sylph supplies the immutable Project, release, Checkpoint, baseline, resource reservation, and encrypted recovery inputs. Do not run production commands with local owner credentials.

The plan declares a Worker, application D1 database, and separate recovery-control D1 database. The control database contains the writer gate, encrypted immutable secret versions, backup manifests, and restore evidence. Application restoration must never rewind it. Its plan entry has `purpose: "recovery_control"`, and its Alchemy removal policy always retains the physical database, including in Preview stages. The production application database also has a retain policy. These policies leave physical data in place if a declaration is removed; Alchemy can still forget the state row. Sylph ownership claims and independently reviewed removal remain required.

Every normal request enters the writer gate. Preparation pauses admission and requires active requests to drain before capture. A failed or uncertain operation retains the pause. An explicitly selected recovery can adopt a drained failed release pause. The authenticated read-only probe verifies the release ID, Checkpoint, application database read, and keyed secret fingerprints while paused. After resume, verification also checks the ordinary root route.

Secret values are staged as encrypted immutable versions before a Worker deploy. Later capture selects the version named by the authenticated live Worker and compares its keyed fingerprints with actual live values. Recovery deployment decrypts the selected version in process memory. It does not write plaintext secrets into repository files or CI snapshots.

Automatic migration review preserves all existing migration files and accepts only new tables and indexes. Recovery validates its explicitly selected immutable target and restores its schema before publishing that code. Other migration forms require a reviewed extension of the contract.

## First release and restore proof

First production preparation creates the two reserved D1 databases through Alchemy, without a Worker. Capture then requires prior real-provider restore evidence for the application schema. Absence of evidence blocks the release; local tests are insufficient.

After approval, provision a separate disposable D1 database named `sylph-recovery-drill-*` through Alchemy and apply the application migrations to it. Run `bun scripts/sylph-recovery-drill.ts` with its ID in `SYLPH_RECOVERY_DRILL_DATABASE_ID`, the target control database ID in `SYLPH_RECOVERY_CONTROL_DATABASE_ID`, and explicit `SYLPH_RECOVERY_DRILL_CONFIRM=restore:<disposable-database-id>`. The other required inputs are `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SYLPH_PROJECT_ID`, and `SYLPH_RECOVERY_KEY`. Use the protected CI credential path. The drill adds data, performs a real Time Travel restore, independently reads the result, and records schema-specific evidence in control storage. First preparation checks for this evidence before acquiring the writer pause, so a missing initial drill does not block the drill itself. Retry through the normal Project release flow after the drill passes.

The adapter supports D1 and encrypted secret versions. It rejects unsupported storage bindings and scheduled writers. Its independently verified fingerprint bound is 10,000 rows per application table. A larger database or new stateful binding requires another verified adapter before release.

## Publication

This is an unpublished candidate until its immutable commit is pushed after approval and Sylph updates its pinned release. Existing Projects must receive these changes as a new reviewed Checkpoint. Do not overwrite accepted history or adopt existing Cloudflare resources without the Project ownership workflow.

## Existing resources

This starter generates fresh reserved names and does not opt resources into Alchemy adoption. It does not implement arbitrary legacy names or automatically rewrite an existing stack. A Project adoption review records Sylph ownership only; a separate reviewed source change must preserve the existing physical names and logical IDs and set per-resource Alchemy adoption policy for the resources explicitly approved. Generic application adoption cannot claim the recovery-control database. Never replace these policies with a blanket adoption flag.
