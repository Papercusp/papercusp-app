/**
 * Shared Ajv-resolver factory for forms whose schema is JSON Schema (the
 * per-plugin config editor; arbitrary plugin-author schemas).
 *
 * Wraps `@hookform/resolvers/ajv` with a pre-built Ajv instance that has
 * `ajv-formats` registered, so format keywords (`email`, `uri`, `uuid`,
 * `date-time`, etc.) resolve correctly without each call site re-registering.
 *
 * Usage (inside the plugin config editor):
 *
 *   import { useForm } from 'react-hook-form';
 *   import { makeAjvResolver } from './ajvResolver';
 *
 *   const resolver = useMemo(() => makeAjvResolver(plugin.configSchema), [plugin.configSchema]);
 *   const { register, handleSubmit, formState: { errors } } = useForm({
 *     resolver,
 *     defaultValues: loaded ?? {},
 *   });
 */
import { ajvResolver } from '@hookform/resolvers/ajv';
import { fullFormats } from 'ajv-formats/dist/formats';
import type { JSONSchemaType } from 'ajv';

export function makeAjvResolver<T = Record<string, unknown>>(schema: object) {
  // Cast: plugin schemas are loose JSON Schema, not JSONSchemaType<T>.
  // The resolver accepts the looser shape at runtime.
  //
  // No `mode: 'async'`: @hookform/resolvers/ajv compiles `$async: true` in
  // that mode, and ajv async validators return a Promise (always truthy) —
  // the resolver then reports `errors: {}` for INVALID data and the real
  // failure escapes as an unhandled rejection. Plugin schemas are plain
  // synchronous JSON Schema; sync mode is the only correct one here.
  return ajvResolver<T>(schema as JSONSchemaType<T>, {
    formats: fullFormats,
  });
}
