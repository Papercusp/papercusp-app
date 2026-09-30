# Android app root reference

`android-app.checks-config.example.json` is a neutral, non-product answer
record for the exact `papercusp-android-app@0.1.0` closure. It demonstrates the
tagged `<template-id>:<decision-point-id>` key contract without carrying a
credential, keystore, service payload, or reference-consumer identity.

In a materialized app, retain the resolved dependency manifests under
`template-manifests/`, replace every answer, and keep the checks config beside
the source as release provenance. The example manifest paths are app-relative;
the fixture suite validates the answer set against the canonical manifests in
this repository.
