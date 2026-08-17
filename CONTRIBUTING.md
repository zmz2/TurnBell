# Contributing

Bug reports and narrowly scoped pull requests are welcome.

## Before reporting a bug

Please include:

- Windows version;
- Microsoft Edge version;
- TurnBell version;
- whether the reply used normal or Instant / “极速” mode;
- whether the ChatGPT tab was foreground, background, sleeping, or discarded;
- whether the issue concerns completion detection, duplicate suppression, notification display, or sound;
- exact reproduction steps.

Do not include account cookies, tokens, private conversation text, or other credentials.

## Development checks

Run all checks before opening a pull request:

```bash
node --test extension/tests/*.test.js
find extension -name '*.js' -print0 | xargs -0 -n1 node --check
python3 -m unittest discover -s scripts/tests -v
python3 -m py_compile scripts/*.py scripts/tests/*.py
./scripts/build-all.sh
```

## Scope

Please keep contributions aligned with the project's privacy boundary:

- no response-stream interception;
- no Cookie or credential access;
- no remote JavaScript;
- no telemetry by default;
- no hidden, obfuscated, anti-detection, or policy-bypass behavior.
