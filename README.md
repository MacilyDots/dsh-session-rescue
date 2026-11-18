# dsh-session-rescue

[English](README.md) | [简体中文](README.zh-CN.md)

A session reliability kit for DeepSeek Harness 0.2.x. It detects two failure modes that can leave a session stuck — reasoning repetition loops and reasoning-only empty turns — records evidence for diagnosis, and creates a clean session for recovery.

## Modules

| Module | Purpose | Default |
|---|---|---|
| `degen-guard` | Detects token-level repetition in the reasoning channel, cancels the step, and applies the configured recovery action | enabled |
| `llm-reasoning-retry` | Resends a request once when the upstream ends with thinking only and no text or tool call | enabled |
| `llm-wiretap` | Records the request body and raw upstream SSE to local disk for diagnosis | disabled; enable while investigating |
| `session-inherit` | Mechanically extracts verifiable anchors and creates a clean session with a handoff document; available through the `/inherit` command and the `session_inherit` tool | enabled |
| Front-end reload | `Ctrl+Shift+R` reloads the renderer process without restarting the host | enabled |

The bundle exposes one profile entry with module switches (`guardEnabled`,
`retryEnabled`, `inheritEnabled`, and `wiretapEnabled`). `wiretap` is disabled
by default; enable it only while collecting diagnostics. It is installed
outside the retry wrapper and therefore records the post-retry response. The
retry module keeps its own evidence for reasoning-only empty turns.

## Install

```sh
dsh plugin --profile desktop add dsh-session-rescue
```

Restart DSH after installation.

### Upgrading from standalone plugins

Disable and remove `dsh-degen-guard`, `dsh-llm-wiretap`, `dsh-llm-reasoning-retry`, `dsh-session-inherit`, and `dsh-render-probe` before enabling this bundle. Running both sets mounts duplicate fetch wrappers and recovery services, changes which layer captures a retry, and can create duplicate automatic handoffs.

## Recovery after a fused trip

`degen-guard` fuses a session after repeated degeneration trips. Configure the recovery action with `onFused`:

| Value | Behavior |
|---|---|
| `hint` (default) | Add `/inherit <sessionId>` to the stop reason; create nothing |
| `draft` | Create a new session and append the handoff document without starting the model |
| `auto` | Wait for the source agent to become idle, then start the new session with a bounded recovery prompt |

`auto` is capped by `maxAutoChain` (default 1). After the cap is reached, a further fused trip falls back to `draft`. If the workspace or inherited preset cannot be verified, the same child session becomes a draft rather than being recreated. A create timeout is never retried.

Switch modes from the current session:

```text
/degen-mode            show the effective value
/degen-mode auto       persist auto mode
/degen-mode draft      persist draft mode
/degen-mode hint       persist hint mode
```

The diagnostics endpoint reports `effectiveOnFused` and `effectiveMaxAutoChain`. Editing `cordis.patch.yml` takes effect without a restart because these fields are volatile.

## Front-end blank body

If an assistant reply is hidden and only a host restart brings it back, press `Ctrl+Shift+R`. This reloads the renderer process. Running agents, sessions, and tasks live in the host process and are not affected. This is a recovery entry point; it does not prevent the underlying UI fault.

## Local data and privacy

- `llm-wiretap` writes request bodies and raw SSE streams under the DSH home logs directory. Credential headers are redacted, but request bodies can contain task content. Leave it disabled unless collecting evidence.
- `degen-guard` writes handoff notes under the DSH home handoff directory and reads session archives to extract anchors.
- `session-inherit` reads session logs and writes a handoff document as the first message of a new session.

The kit does not upload these files.

## Verification status

Module test suites pass locally, including service call order, depth registration before prompt, timeout handling, and degraded fallback paths. The full host-side recovery chain has not been observed on a real fused trip. The reload shortcut is present in the client bundle; its effectiveness against the blank-body symptom is a mechanism-based inference because no before/after comparison was captured.

## Feedback

If a recovery path behaves unexpectedly, or the reload shortcut fails to restore the body, open an issue at https://github.com/MacilyDots/dsh-session-rescue/issues with the DSH version, the module involved, and relevant lines from `%DSH_HOME%\logs\`.

## License

MIT — Macily
