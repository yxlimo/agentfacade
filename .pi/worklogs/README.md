# Task logs

One file per task worked in a worktree: `<task-name>.md`.

A task log is the running state of a task, not a summary written at the end. Append to it as
you go, and commit it together with the change it describes — so that a timeout, an upstream
error or a closed terminal costs nothing that cannot be recovered from the branch.

Shape:

```md
# <task name>

## What I was asked to do
One paragraph. Quote the constraints that decide the shape of the answer.

## Steps
- <what I did> → <what I learned> (files, test results, causes)

## Open questions
- <what I could not decide alone, and what I would need to know>
```

The main agent reads the last section first when picking the work up.
