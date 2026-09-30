---
title: "\"Not deployed\" is not \"not live\" — some processes run straight from the tree"
kind: project
applies_to: [any]
type: project
---

Papercusp's pipeline reader tells you where an edited file sits: committed, promoted, deployed. Agents routinely read a false "deployed" flag as "my change is not live" — and for some paths that inference is simply wrong.

Not every process reads the released checkout. A service launched directly from the working tree has no build and no deploy step, so its code is live the moment the process restarts, while the pipeline reader honestly reports it as undeployed and not yet promoted. The reader signals this: it carries a flag saying whether the release pipeline APPLIES to the path you asked about, and it names the correct lever when it does not — usually a targeted restart rather than a deploy.

So read whether the pipeline applies BEFORE concluding a change is not live, and read whether the running process started after your edit to tell whether it actually includes it.

The generalisation error to avoid is applying the main operator's deployment model — a released checkout serving a green branch — to every file in a plan. Which model governs is a property of the PATH, not of the repository.
