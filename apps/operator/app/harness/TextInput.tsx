'use client';

/**
 * Compatibility entrypoint for the registry control extracted to the shared
 * package. Existing operator imports keep one implementation while portal and
 * future app shells consume the maintained cross-app surface directly.
 */
export {
  TextArea,
  TextInput,
  type TextAreaProps,
  type TextInputProps,
} from '@papercusp/ui-primitives/controls';
