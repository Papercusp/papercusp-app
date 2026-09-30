# `lib/forms` — react-hook-form conventions

This is the shared form-state foundation for `apps/operator`. **All new
forms in the operator UI should use these primitives** instead of
hand-rolled `useState` / `onSubmit` / `disabled={busy}` patterns. The
plumbing for validation, dirty-tracking, error display, and pending
state lives here so call sites stay tight.

## What's in here

- **`useFormWith(schema, options?)`** — wraps `react-hook-form`'s `useForm`
  with `zodResolver`. Returns `{ register, control, submit, errors,
  isSubmitting, isDirty, methods, ... }`. The `submit` field is RHF's
  `handleSubmit` pre-extracted so call sites don't repeat
  `formState.handleSubmit`.
- **`FormField`** — labelled wrapper around any input. Accepts a
  `FieldError` (from `errors[name]`) or a plain string and renders it
  inline. Visual styling matches the rest of the operator (CSS variables,
  no design-system kit).
- **`SubmitButton`** — disabled-while-submitting button. Takes a `pending`
  bool (usually `isSubmitting` from `useFormWith`).
- **`DraftInput` / `DraftTextarea`** — commit-on-blur text inputs for
  **per-field auto-save pages** (the `useDebouncedSave` pattern, not RHF).
  Typing stays in a local draft; `onCommit(value)` fires on blur/Enter only
  when the optional `validate(draft)` passes — so a mid-typed or invalid
  value never reaches the page state that auto-saves. Escape reverts. On an
  auto-save page, a plain `<input value onChange>` persists every keystroke
  — always wrap free-text fields in these.
- **`makeAjvResolver(schema)`** — for the per-plugin config editor and any
  other surface whose schema is JSON Schema, not Zod. Pre-registers
  `ajv-formats`. Used with vanilla `useForm`, not `useFormWith`.

## When to use what

| Surface | Use |
|---|---|
| New form, schema you control | `useFormWith` + Zod schema |
| Server-defined Zod schema (e.g. `lib/validators.ts`) | `useFormWith` with the imported schema |
| JSON Schema from a plugin manifest | `useForm` directly with `makeAjvResolver(schema)` |
| Single textarea + Cmd-Enter chat composer | **Don't migrate.** RHF buys nothing for one-field IME-aware composers. |
| Monaco code editor (`SpecEditor`, `ManifestSpecEditor`) | Don't migrate. RHF doesn't model code editors. |

## Migration recipe

Replacing a hand-rolled form is mechanical:

```tsx
// Before
const [name, setName] = useState('');
const [busy, setBusy] = useState(false);
async function submit(e) {
  e.preventDefault();
  setBusy(true);
  await fetch('/api/...', { method: 'POST', body: JSON.stringify({ name }) });
  setBusy(false);
}
return (
  <form onSubmit={submit}>
    <label>Name</label>
    <input value={name} onChange={(e) => setName(e.target.value)} />
    <button disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
  </form>
);

// After
import { z } from 'zod';
import { useFormWith, FormField, SubmitButton } from '@/lib/forms';

const Schema = z.object({ name: z.string().min(1) });

const { register, submit, errors, isSubmitting } = useFormWith(Schema);
const onSubmit = async (data: z.infer<typeof Schema>) => {
  await fetch('/api/...', { method: 'POST', body: JSON.stringify(data) });
};
return (
  <form onSubmit={submit(onSubmit)}>
    <FormField label="Name" required error={errors.name}>
      <input {...register('name')} />
    </FormField>
    <SubmitButton pending={isSubmitting}>Save</SubmitButton>
  </form>
);
```

## Why react-hook-form

Picked over `@rjsf/core`, `@jsonforms/react`, `@formily/react`,
`@formisch/react`, and `@tanstack/react-form` after a comparison pass
(2026-05-02). The decision summary:

- ~33 KB min / 11 KB gzip; zero deps; v7.75.0 active (released today).
- Uncontrolled inputs → minimal re-renders; the lowest-overhead option for
  the operator's many small forms.
- SSR works behind a `"use client"` boundary. Operator forms already are
  client components.
- JSON Schema is supported via the official `@hookform/resolvers/ajv`
  resolver — important for the per-plugin config editor where third-party
  authors ship JSON Schema.
- Same library covers Zod-schema'd internal forms (settings, login,
  templates) and JSON-Schema'd dynamic forms (plugin config), so the team
  only learns one form mental model.

See the design-doc rationale at `/docs/design/react-hook-form` (operator
docs site) for the full background.
