/**
 * useFormWith — thin wrapper around react-hook-form's `useForm` that auto-wires
 * a Zod schema as the resolver and exposes a tighter, type-inferred API.
 *
 * Intent: every form in apps/operator goes through this helper instead of
 * calling `useForm` directly, so the migration from hand-rolled `useState`
 * forms is a one-liner per call site and the resolver wiring stays consistent.
 *
 * Usage:
 *   const Schema = z.object({ email: z.string().email(), password: z.string().min(8) });
 *   const { register, submit, errors, isSubmitting, methods } = useFormWith(Schema);
 *   <form onSubmit={submit(async (data) => { ... })}>
 *     <FormField label="Email" error={errors.email}>
 *       <input {...register('email')} />
 *     </FormField>
 *   </form>
 *
 * For dynamic JSON Schema use cases (the per-plugin config editor) reach for
 * `@hookform/resolvers/ajv` directly with `useForm` — schemas there aren't
 * Zod-shaped.
 */
import { useForm, type FieldValues, type UseFormProps, type UseFormReturn, type DefaultValues } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z, ZodType } from 'zod';

export interface UseFormWithReturn<S extends ZodType<FieldValues>> {
  methods: UseFormReturn<z.infer<S>>;
  register: UseFormReturn<z.infer<S>>['register'];
  control: UseFormReturn<z.infer<S>>['control'];
  reset: UseFormReturn<z.infer<S>>['reset'];
  setValue: UseFormReturn<z.infer<S>>['setValue'];
  setError: UseFormReturn<z.infer<S>>['setError'];
  getValues: UseFormReturn<z.infer<S>>['getValues'];
  watch: UseFormReturn<z.infer<S>>['watch'];
  /** Pre-bound to handleSubmit — pass an async onValid; errors are mapped to inline FormField messages by zodResolver. */
  submit: UseFormReturn<z.infer<S>>['handleSubmit'];
  errors: UseFormReturn<z.infer<S>>['formState']['errors'];
  isSubmitting: boolean;
  isDirty: boolean;
}

export function useFormWith<S extends ZodType<FieldValues>>(
  schema: S,
  options?: Omit<UseFormProps<z.infer<S>>, 'resolver'> & { defaultValues?: DefaultValues<z.infer<S>> },
): UseFormWithReturn<S> {
  const methods = useForm<z.infer<S>>({
    ...options,
    resolver: zodResolver(schema),
  });
  return {
    methods,
    register: methods.register,
    control: methods.control,
    reset: methods.reset,
    setValue: methods.setValue,
    setError: methods.setError,
    getValues: methods.getValues,
    watch: methods.watch,
    submit: methods.handleSubmit,
    errors: methods.formState.errors,
    isSubmitting: methods.formState.isSubmitting,
    isDirty: methods.formState.isDirty,
  };
}
