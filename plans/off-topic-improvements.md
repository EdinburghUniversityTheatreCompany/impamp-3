# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

Deferred dependency upgrades live in `plans/deferred-upgrades.md`, not here.

## A renamed profile never converges, and the conflict modal lies about it

`src/lib/googleDrive/dataAccess.ts:278` — `updateLocalData` pins the profile
name to the local value:

```ts
name: existingLocalProfile?.name ?? data.profile.name,
```

`existingLocalProfile.name` is always set, so the local name always wins and a
remote rename never lands. Nothing else applies one either — `applySyncedProfile`
does not touch the name, and no other call site writes it from sync data.

The sharp edge is that `detectProfileConflicts` disagrees. It treats `name` as
ordinary content, merges a newer remote name into `mergedData`, and can raise a
**manual conflict** over it — so the resolution modal asks the user to choose
between two names, and then `updateLocalData` discards the choice if they picked
the remote one. Either the name is local-only bookkeeping (in which case it
belongs in `PROFILE_LOCATION_FIELDS` and should never reach the modal) or it is
content (in which case the pin should go). Right now it is both.

Noticed while excluding the _location_ fields from the merge; the name is a
separate question, and changing it alters convergence for every existing synced
profile, so it wanted its own change and its own test.
