# Sandbox tmp blocks unix sockets — subprocess/tsx tests EPERM (skip, don't chase)
URL: /internal/docs/agent-insights/sandbox-tmp-blocks-unix-sockets-tsx-guard

Symptom `listen EPERM /tmp/claude/…pipe` in a cup capability_bash sandbox = the sandbox rejects AF_UNIX socket bind everywhere; a test spawning tsx (or any tool that opens a tmp unix socket) must self-skip, not false-alarm.

# Sandbox tmp blocks unix sockets — subprocess/tsx tests EPERM (skip, don't chase)

## Symptom

A test that shells out to `tsx` (or any tool opening a unix-domain socket under
`os.tmpdir()`) fails inside the **cup `capability_bash` sandbox** with:

```
Error: listen EPERM: operation not permitted /tmp/claude/tsx-1000/<pid>.pipe
```

thrown from tsx's own `createIpcServer` (`node_modules/tsx/dist/cli.mjs`) —
**before** tsx imports anything. So every subtest fails identically with an
*environment* error, not a real code break. (First seen: `EI-12473`,
`tsx-runtime-imports.test.ts` — all 5 subtests red only in the sandbox, green on
the dev box / green-checkpoint gate.)

## Root cause

The cup `capability_bash` sandbox's writable tmp is `/tmp/claude` (via
`TMPDIR`), and the sandbox **rejects `listen()`/`bind()` on AF\_UNIX sockets in
*every* writable directory** — `/tmp`, `/tmp/claude`, `/dev/shm`, and `$HOME`
all `EPERM`. So there is **no `TMPDIR` override that helps**; you cannot relocate
tsx's IPC socket to a bindable dir because none exists in the sandbox.

Quick repro (returns `LISTEN ERR: EPERM` in the sandbox, `LISTEN OK` on a normal box):

```js
const net = require('net'), os = require('os'), path = require('path');
const p = path.join(os.tmpdir(), `sock-${process.pid}.pipe`);
const s = net.createServer();
s.on('error', e => console.log('LISTEN ERR:', e.code));
s.listen(p, () => { console.log('LISTEN OK'); s.close(); require('fs').unlinkSync(p); });
```

This is the **WI-4439 class** (a third-party/hardcoded tmp assumption vs a
locked-down sandbox tmp) — but a *new* manifestation: here it's the **tsx CLI's
own internal IPC socket**, not papercusp code, so making papercusp
`TMPDIR`-aware fixes nothing.

## Fix pattern: probe + self-skip, don't relocate

The test is *inapplicable* in a socket-hostile environment — it can't faithfully
run there, so it should **skip cleanly** (exactly like an already-present
`skipIf(!existsSync(OPERATOR_DIR) || !TSX_CLI)` absence guard), not try to make
tsx behave.

1. Add a probe that binds+closes a unix socket and **never throws** (returns
   `false` on any error, `true` on a clean `listen`) so `describe.skipIf` always
   gets a boolean:

   ```ts
   function probeUnixSocketBindable(sockPath: string): Promise<boolean> {
     return new Promise((res) => {
       const server = createServer();
       const finish = (ok: boolean) => {
         try { server.close(); } catch {}
         try { unlinkSync(sockPath); } catch {}
         res(ok);
       };
       server.once('error', () => finish(false));
       try { server.listen(sockPath, () => finish(true)); } catch { finish(false); }
     });
   }
   const CAN_BIND_UNIX_SOCKET = await probeUnixSocketBindable(
     resolve(tmpdir(), `probe-${process.pid}-${Date.now()}.pipe`),
   );
   ```

2. Add `!CAN_BIND_UNIX_SOCKET` to the guard's `describe.skipIf(...)`.

Top-level `await` is fine here (operator-core tsconfig is `target: ES2022`,
`module: ESNext`). On the real dev box / green gate, `/tmp` binds sockets so the
guard runs for real and still catches genuine breaks — the skip is scoped to the
socket-hostile sandbox only.

## Rule of thumb

`listen EPERM …pipe` (or `EPERM/EROFS` on a `.sock` / IPC path) in a sandboxed
run is an **environment capability gap, not a bug in the code under test**.
Detect the missing capability at collection time and skip; do not widen the tmp
assumption or chase a `TMPDIR` that doesn't exist. This generalizes to any test
spawning a subprocess that opens a unix socket in tmp (tsx, some watchers, IPC
brokers).
