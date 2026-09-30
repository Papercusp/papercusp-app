# PUI fresh-user study — task sheet and observer notes

Plan `pui-first-party-public-release-2026-09-07`, item P-013. Two or three
people who do not know Papercusp's internal terms each try PUI once, about 30
minutes each, while a facilitator watches and writes down where they get stuck.
PUI is being tested, not the participant.

Who takes part and when is the owner's decision (open question
`conv-muf05x9y`). This sheet is ready to use as soon as that is settled.

## Before each session (facilitator)

- A clean Linux x86_64 account with no `~/.papercusp` and no `pui` on `PATH`.
- The release archive being evaluated (`pui-<version>-linux-x86_64.tar.gz`)
  and its `SHA256SUMS`, in the participant's home folder.
- A Papercusp operator the participant can reach. Write its address on the
  participant's copy below. Do not explain what an operator is.
- An empty scratch folder, `~/pui-study`, to use as the working folder.
- A screen recording, with the participant's consent.

## Participant sheet

> You will try a terminal app called PUI. Please say what you are thinking as
> you go: what you expect to happen, and anything that surprises or confuses
> you. There are no wrong answers. If you get stuck, say so and we will note
> it before helping.
>
> 1. **Install it.** Install PUI from the file in your home folder. You are
>    done when PUI starts.
> 2. **Connect it.** Connect PUI to this Papercusp: `____________________`.
>    You are done when PUI is ready for you to ask for something.
> 3. **Ask for something.** Ask the agent which files are in `~/pui-study`.
>    You are done when you can read its answer.
> 4. **Decide on a request.** Ask the agent to create a file named `notes.txt`
>    in `~/pui-study` containing the word `hello`. If PUI asks you anything,
>    tell us what you think will happen, then decide.
> 5. **Come back later.** Quit PUI. Start it again and carry on the same
>    conversation by asking the agent what it just did.

## Observer notes (one table per participant)

| Task | Started | Finished | Completed? (alone / with help / no) | Where they hesitated, and what they expected instead | Words they did not understand | Help given (exact words) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Install | | | | | | |
| 2 Connect | | | | | | |
| 3 Ask | | | | | | |
| 4 Decide | | | | | | |
| 5 Resume | | | | | | |

Also note:

- Every error or warning they saw, word for word, and what they did next.
- Whether they found the tutorial (`F1`) or the key list (`?`) on their own.
- For task 4: what they believed the approval would allow before they
  answered, and whether that matched what happened.

## After each session

1. With the participant's consent, save a support report from PUI's palette
   (`:diagnostics`), or run `pui self diagnostics`. The report leaves out
   conversation content, prompts, tokens and credentials. Read it before you
   store it anyway.
2. Record the release under test: archive name and digest from `SHA256SUMS`,
   and the version shown by `:about`.
3. File each stuck point as its own work item on P-013. Include the task,
   what the participant expected, what PUI did, and the recording timestamp.
   A stuck point seen in two or more sessions is a release fix. One seen once
   is judged on its own merits.
