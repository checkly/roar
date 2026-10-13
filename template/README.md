# ROAR repro template

A deployable Checkly CLI project implementing the ROAR reproduction pattern. Adapt the
three `createResource` / `updateResource` / `deleteResource` functions in
[`__checks__/repro-context.ts`](__checks__/repro-context.ts) to your API, fill in the
issue id/title placeholders, then:

```sh
npm install
npx checkly env add REPRO_API_KEY <key> --secret
npx checkly env add REPRO_TARGET_API https://api.yourservice.example
npx checkly env add REPRO_ISSUE_ID <your error-tracker issue id>
npx checkly test --record    # ad-hoc cloud run
npx checkly deploy           # standing monitor / verify gate
```

Retarget the same project at another account/environment (e.g. a staging gate) purely
with env vars: `CHECKLY_API_KEY=… CHECKLY_ACCOUNT_ID=… npx checkly deploy`.
